import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ScheduledAutoPlanningUseCase } from '../../application/auto-planning/auto-planning.use-cases';
import { CLEANING_DEPS, type CleaningDeps } from '../../application/deps';

export const AUTO_PLANNING_INTERVAL_MS = Symbol('AUTO_PLANNING_INTERVAL_MS');

/**
 * Tâche planifiée interne (UC-NT-45, R-PL-01) : passage de la planification automatique sur
 * l'horizon glissant des réglages, sur le modèle des tâches de la v1. Un seul passage à la fois par
 * instance ; entre répliques, le verrou consultatif du passage fait que la seconde ne fait rien.
 * Les erreurs sont journalisées sans arrêter la tâche ; seuls les nombres sont journalisés.
 * Intervalle 0 : tâche désactivée.
 */
@Injectable()
export class AutoPlanningScheduler implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(AutoPlanningScheduler.name);
  private readonly useCase: ScheduledAutoPlanningUseCase;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(CLEANING_DEPS) deps: CleaningDeps,
    @Inject(AUTO_PLANNING_INTERVAL_MS) private readonly intervalMs: number,
  ) {
    this.useCase = new ScheduledAutoPlanningUseCase(deps);
  }

  onApplicationBootstrap(): void {
    if (this.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  beforeApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const run = await this.useCase.execute();
      if (run && (run.assigned || run.proposed || run.failures.length)) {
        this.logger.log(
          `Planification automatique : ${run.assigned} affectation(s), ${run.proposed} proposition(s), ${run.failures.length} séance(s) sans équipe`,
        );
      }
    } catch (error) {
      this.logger.error(`Planification automatique en échec : ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
