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

  /** Un seul passage à la fois ; une erreur est journalisée sans arrêter la tâche. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { issued } = await this.useCases.issueDueInvoices.execute();
      const { overdue } = await this.useCases.markOverdueInvoices.execute();
      if (issued || overdue) this.logger.log(`Factures émises : ${issued} ; passées impayées : ${overdue}`);
    } catch (error) {
      this.logger.error(`Facturation planifiée en échec : ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
