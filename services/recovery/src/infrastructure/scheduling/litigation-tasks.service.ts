import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { RECOVERY_USE_CASES, type RecoveryUseCases } from '../../application/use-cases';

export const LITIGATION_TASKS_INTERVAL_MS = Symbol('LITIGATION_TASKS_INTERVAL_MS');

/**
 * Tâche planifiée interne du contentieux (ADR-060, point 17) : mise en demeure restée sans effet
 * (huissier proposé), partenaires sans nouvelles, missions des dossiers clos. Plusieurs instances
 * peuvent tourner (écritures conditionnées). Intervalle 0 : tâche désactivée. Seuls des compteurs sont
 * journalisés.
 */
@Injectable()
export class LitigationTasksService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(LitigationTasksService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(RECOVERY_USE_CASES) private readonly useCases: RecoveryUseCases,
    @Inject(LITIGATION_TASKS_INTERVAL_MS) private readonly intervalMs: number,
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
      const report = await this.useCases.watchLitigation.execute();
      const { failed, ...counters } = report;
      const done = Object.entries(counters).filter(([, count]) => count > 0);
      if (done.length > 0) {
        this.logger.log(`Contentieux : ${done.map(([name, count]) => `${name}=${count}`).join(', ')}`);
      }
      if (failed) this.logger.warn(`Contentieux : ${failed} ligne(s) reprise(s) au prochain passage`);
    } catch (error) {
      this.logger.error(`Contentieux en échec : ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
