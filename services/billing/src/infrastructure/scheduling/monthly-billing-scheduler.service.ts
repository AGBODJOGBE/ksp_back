import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { MONTHLY_USE_CASES, type MonthlyBillingUseCases } from '../../application/monthly/use-cases';
import { BILLING_SCHEDULER_INTERVAL_MS } from './billing-scheduler.service';
import { PgRunLock } from './pg-run-lock';

/** Nom du verrou consultatif de la tâche (une seule réplique à la fois). */
export const MONTHLY_BILLING_LOCK = 'billing.monthly_billing';
/** Durée maximale d'un passage sous verrou ; au-delà, le verrou est rendu (écritures idempotentes). */
export const MONTHLY_BILLING_MAX_RUN_MS = 10 * 60_000;

/**
 * Tâche planifiée du lot F (UC-NT-47) : émission des factures mensuelles du mois écoulé (le 1er à
 * 00:00, heure du Bénin, au premier passage), passage en « impayée » le lendemain de l'échéance,
 * relances. Un seul passage à la fois par instance, et une seule réplique grâce au verrou consultatif ;
 * lots de 200 ; chaque étape a sa garde : une erreur est journalisée sans arrêter les autres, et le
 * passage suivant reprend. Intervalle 0 : tâche désactivée.
 */
@Injectable()
export class MonthlyBillingSchedulerService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(MonthlyBillingSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(MONTHLY_USE_CASES) private readonly useCases: MonthlyBillingUseCases,
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
        MONTHLY_BILLING_LOCK,
        () => this.pass(),
        MONTHLY_BILLING_MAX_RUN_MS,
      );
      return outcome.ran ? 'ran' : 'skipped';
    } catch (error) {
      this.logger.error(
        `Facturation mensuelle en échec, reprise au prochain passage : ${(error as Error).message}`,
      );
      return 'skipped';
    } finally {
      this.running = false;
    }
  }

  private async pass(): Promise<void> {
    const issued = await this.step('Émission des factures mensuelles', async () => {
      const { issued, deferredOrganizationIds } = await this.useCases.issueMonthlyInvoices.execute();
      if (deferredOrganizationIds.length > 0) {
        // R-PE-02 : organisation introuvable dans identity, facture reportée ; à corriger à la main.
        this.logger.error(
          `ALERTE facturation : organisations introuvables dans identity, factures reportées : ${deferredOrganizationIds.join(', ')}`,
        );
      }
      return issued;
    });
    const overdue = await this.step(
      'Passage en impayée (factures mensuelles)',
      async () => (await this.useCases.markMonthlyInvoicesOverdue.execute()).overdue,
    );
    const reminded = await this.step(
      'Relances',
      async () => (await this.useCases.sendInvoiceReminders.execute()).reminded,
    );
    if (issued || overdue || reminded) {
      this.logger.log(
        `Factures mensuelles émises : ${issued} ; passées impayées : ${overdue} ; relances : ${reminded}`,
      );
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
