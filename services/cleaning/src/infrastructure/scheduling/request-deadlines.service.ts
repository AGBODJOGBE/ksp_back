import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { CLEANING_USE_CASES, type CleaningUseCases } from '../../application/use-cases';

export const REQUEST_DEADLINES_INTERVAL_MS = Symbol('REQUEST_DEADLINES_INTERVAL_MS');

/**
 * Tâche planifiée interne : échéances des demandes (ADR-053) — devis expirés, rappels avant
 * l'expiration, visites des demandes closes. Plusieurs instances peuvent tourner : chaque écriture
 * est conditionnée (version ou marquage), la seconde instance ne publie rien. Intervalle 0 :
 * tâche désactivée.
 */
@Injectable()
export class RequestDeadlinesService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(RequestDeadlinesService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(CLEANING_USE_CASES) private readonly useCases: CleaningUseCases,
    @Inject(REQUEST_DEADLINES_INTERVAL_MS) private readonly intervalMs: number,
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
      const report = await this.useCases.watchRequestDeadlines.execute();
      if (report.failed) {
        this.logger.warn(`Échéances des demandes : ${report.failed} lots repris au prochain passage`);
      }
    } catch (error) {
      this.logger.error(`Échéances des demandes en échec : ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
