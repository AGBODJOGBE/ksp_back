import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { BILLING_USE_CASES, type BillingUseCases } from '../../application/use-cases';

export const BILLING_SCHEDULER_INTERVAL_MS = Symbol('BILLING_SCHEDULER_INTERVAL_MS');

/**
 * Tâche planifiée interne : émission des factures des mois terminés, puis passage en « impayée »
 * des factures à échéance. Idempotente (une facture par contrat et par mois, transitions
 * conditionnelles) : plusieurs instances peuvent tourner. Intervalle 0 : tâche désactivée.
 */
@Injectable()
export class BillingSchedulerService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(BillingSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(BILLING_USE_CASES) private readonly useCases: BillingUseCases,
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

  /**
   * Un seul passage à la fois. Chaque étape a sa propre garde : une émission en échec (identity
   * indisponible : aucune facture sans en-tête) n'empêche pas le passage en « impayée », et le
   * passage suivant la reprend. Une erreur est journalisée sans arrêter la tâche.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const issued = await this.step('Émission des factures', async () => {
        const { issued, deferredContractIds } = await this.useCases.issueDueInvoices.execute();
        if (deferredContractIds.length > 0) {
          this.logger.warn(
            `Factures reportées, organisation introuvable dans identity : contrats ${deferredContractIds.join(', ')}`,
          );
        }
        return issued;
      });
      const overdue = await this.step(
        'Passage en impayée',
        async () => (await this.useCases.markOverdueInvoices.execute()).overdue,
      );
      if (issued || overdue) this.logger.log(`Factures émises : ${issued} ; passées impayées : ${overdue}`);
    } finally {
      this.running = false;
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
