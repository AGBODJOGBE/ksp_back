import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  RECOVERY_BILLING_USE_CASES,
  type RecoveryBillingUseCases,
} from '../../application/recovery/use-cases';
import { BILLING_SCHEDULER_INTERVAL_MS } from './billing-scheduler.service';
import { PgRunLock } from './pg-run-lock';

/** Nom du verrou consultatif de la tâche (une seule réplique à la fois). */
export const COMMISSION_BILLING_LOCK = 'billing.commission_billing';
/** Durée maximale d'un passage sous verrou ; au-delà, le verrou est rendu (écritures idempotentes). */
export const COMMISSION_BILLING_MAX_RUN_MS = 10 * 60_000;

/**
 * Tâche planifiée du recouvrement (ADR-064), sur le modèle de celle du lot F : émission des factures
 * de commission du mois écoulé (le 1er à 00:00, heure du Bénin, au premier passage), puis débit
 * automatique de la commission à débiter, à l'émission et aux nouveaux essais échus. Un seul passage à
 * la fois par instance, et une seule réplique grâce au verrou consultatif ; lots de 200 ; chaque étape
 * a sa garde : une erreur est journalisée sans arrêter l'autre, et le passage suivant reprend.
 * Intervalle 0 : tâche désactivée.
 */
@Injectable()
export class CommissionBillingSchedulerService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(CommissionBillingSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(RECOVERY_BILLING_USE_CASES) private readonly useCases: RecoveryBillingUseCases,
    private readonly lock: PgRunLock,
    @Inject(BILLING_SCHEDULER_INTERVAL_MS) private readonly intervalMs: number,
  ) {}

  onApplicationBootstrap(): void {
    if (this.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  beforeApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<'ran' | 'skipped'> {
    if (this.running) return 'skipped';
    this.running = true;
    try {
      const outcome = await this.lock.tryRun(
        COMMISSION_BILLING_LOCK,
        () => this.pass(),
        COMMISSION_BILLING_MAX_RUN_MS,
      );
      return outcome.ran ? 'ran' : 'skipped';
    } catch (error) {
      this.logger.error(
        `Facturation du recouvrement en échec, reprise au prochain passage : ${(error as Error).message}`,
      );
      return 'skipped';
    } finally {
      this.running = false;
    }
  }

  private async pass(): Promise<void> {
    const issued = await this.step('Émission des factures de commission', async () => {
      const { issued, deferredOrganizationIds } = await this.useCases.issueCommissionInvoices.execute();
      if (deferredOrganizationIds.length > 0) {
        // Organisation introuvable dans identity : facture reportée ; à corriger à la main.
        this.logger.error(
          `ALERTE facturation : organisations créancières introuvables dans identity, factures de commission reportées : ${deferredOrganizationIds.join(', ')}`,
        );
      }
      return issued;
    });
    const paid = await this.step('Débit des commissions', async () => {
      const { paid, failures } = await this.useCases.debitCommissionInvoices.execute();
      const insufficient = failures.filter((failure) => failure.reason === 'insufficient_funds');
      const errors = failures.filter((failure) => failure.reason === 'wallet_error');
      if (insufficient.length > 0) {
        // Identifiants seulement : la finance suit ces factures au back-office.
        this.logger.warn(
          `Commissions non débitées, solde insuffisant (nouvel essai plus tard) : ${insufficient
            .map((failure) => failure.invoiceNumber)
            .join(', ')}`,
        );
      }
      if (errors.length > 0) {
        this.logger.error(
          `Commissions non débitées, wallet en échec : ${errors
            .map((failure) => `${failure.invoiceNumber} (${failure.code})`)
            .join(', ')}`,
        );
      }
      return paid;
    });
    if (issued || paid) {
      this.logger.log(`Factures de commission émises : ${issued} ; commissions débitées : ${paid}`);
    }
  }

  private async step(name: string, run: () => Promise<number>): Promise<number> {
    try {
      return await run();
    } catch (error) {
      this.logger.error(`${name} en échec, reprise au prochain passage : ${(error as Error).message}`);
      return 0;
    }
  }
}
