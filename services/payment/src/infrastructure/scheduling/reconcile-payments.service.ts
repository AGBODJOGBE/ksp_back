import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PAYMENT_USE_CASES, type PaymentUseCases } from '../../application/use-cases';

export const RECONCILE_INTERVAL_MS = Symbol('RECONCILE_INTERVAL_MS');

/**
 * Rapprochement planifié (ADR-031) : les paiements en attente sont relus chez le prestataire
 * (notification perdue ou retardée), puis expirés au-delà de leur délai. Intervalle 0 : désactivé.
 * Plusieurs instances peuvent tourner : chaque changement d'état est protégé par sa version.
 */
@Injectable()
export class ReconcilePaymentsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ReconcilePaymentsService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(PAYMENT_USE_CASES) private readonly useCases: PaymentUseCases,
    @Inject(RECONCILE_INTERVAL_MS) private readonly intervalMs: number,
  ) {}

  onApplicationBootstrap(): void {
    if (this.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.useCases.reconcilePendingPayments.execute();
      if (result.examined) {
        this.logger.log(
          `Rapprochement : ${result.examined} examinés, ${result.succeeded} réglés, ` +
            `${result.failed} non aboutis, ${result.errors} en erreur`,
        );
      }
    } catch (error) {
      this.logger.warn(`Rapprochement interrompu : ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
