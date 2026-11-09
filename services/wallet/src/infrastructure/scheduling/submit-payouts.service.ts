import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { WALLET_USE_CASES, type WalletUseCases } from '../../application/use-cases';

export const SUBMIT_INTERVAL_MS = Symbol('SUBMIT_INTERVAL_MS');

/**
 * Transmission planifiée des reversements restés en attente (payment injoignable au premier essai,
 * ADR-042). Intervalle 0 : désactivé. Plusieurs instances peuvent tourner : payment est idempotent
 * par clé et chaque changement d'état est protégé par sa version.
 */
@Injectable()
export class SubmitPayoutsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SubmitPayoutsService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(WALLET_USE_CASES) private readonly useCases: WalletUseCases,
    @Inject(SUBMIT_INTERVAL_MS) private readonly intervalMs: number,
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
      const result = await this.useCases.submitPendingPayouts.execute();
      if (result.examined) {
        this.logger.log(
          `Reversements en attente : ${result.examined} examinés, ${result.submitted} transmis à payment, ` +
            `${result.examined - result.submitted} toujours en attente`,
        );
      }
    } catch (error) {
      this.logger.warn(`Transmission des reversements interrompue : ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
