import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { CLEANING_USE_CASES, type CleaningUseCases } from '../../application/use-cases';

export const PAYMENT_WATCH_INTERVAL_MS = Symbol('PAYMENT_WATCH_INTERVAL_MS');

/**
 * Tâche planifiée interne : passages impayés des particuliers en récurrent (CDC Nettoyage,
 * partie 10). Plusieurs instances peuvent tourner : chaque décision est enregistrée avec un
 * contrôle de version, la seconde instance ne fait rien. Intervalle 0 : tâche désactivée.
 */
@Injectable()
export class PaymentWatchService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(PaymentWatchService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(CLEANING_USE_CASES) private readonly useCases: CleaningUseCases,
    @Inject(PAYMENT_WATCH_INTERVAL_MS) private readonly intervalMs: number,
  ) {}

  onApplicationBootstrap(): void {
    if (this.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  beforeApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Un seul passage à la fois ; les erreurs sont journalisées sans arrêter la tâche. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { examined, failed } = await this.useCases.watchIndividualPayments.execute();
      if (failed) this.logger.warn(`Impayés des particuliers : ${failed}/${examined} missions en échec`);
    } catch (error) {
      this.logger.error(`Surveillance des impayés en échec : ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
