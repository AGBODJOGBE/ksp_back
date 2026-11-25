import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { RECOVERY_USE_CASES, type RecoveryUseCases } from '../../application/use-cases';

export const AMICABLE_TASKS_INTERVAL_MS = Symbol('AMICABLE_TASKS_INTERVAL_MS');

/**
 * Tâche planifiée interne de la procédure amiable (ADR-060, point 17) : premier contact, échéances et
 * rappels, promesses, avancement des étapes, décisions échues, envoi des messages au débiteur dans la
 * plage de contact. Plusieurs instances peuvent tourner (écritures conditionnées, messages réservés).
 * Intervalle 0 : tâche désactivée. Seuls des compteurs sont journalisés.
 */
@Injectable()
export class AmicableTasksService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(AmicableTasksService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(RECOVERY_USE_CASES) private readonly useCases: RecoveryUseCases,
    @Inject(AMICABLE_TASKS_INTERVAL_MS) private readonly intervalMs: number,
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
      const report = await this.useCases.watchAmicable.execute();
      const { failed, ...counters } = report;
      const done = Object.entries(counters).filter(([, count]) => count > 0);
      if (done.length > 0) {
        this.logger.log(`Procédure amiable : ${done.map(([name, count]) => `${name}=${count}`).join(', ')}`);
      }
      if (failed) this.logger.warn(`Procédure amiable : ${failed} ligne(s) reprise(s) au prochain passage`);
    } catch (error) {
      this.logger.error(`Procédure amiable en échec : ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
