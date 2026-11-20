import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { LOT_C_USE_CASES, type LotCUseCases } from '../../application/requests/lot-c-use-cases';

export const CASE_DEADLINES_INTERVAL_MS = Symbol('CASE_DEADLINES_INTERVAL_MS');

/**
 * Tâche planifiée interne des échéances du dossier (UC-NT-44, RV-13), sur le modèle de la v1 : un
 * seul passage à la fois dans l'instance, `unref`, intervalle 0 = désactivée, erreurs journalisées
 * sans arrêter la tâche. Entre répliques, le verrou consultatif du dépôt laisse passer une seule
 * instance ; chaque écriture reste conditionnée à la version du dossier. Journal : nombres seulement.
 */
@Injectable()
export class CaseDeadlinesService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(CaseDeadlinesService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(LOT_C_USE_CASES) private readonly useCases: LotCUseCases,
    @Inject(CASE_DEADLINES_INTERVAL_MS) private readonly intervalMs: number,
  ) {}

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
      const report = await this.useCases.deadlines.execute();
      if (report.failed)
        this.logger.warn(`Échéances du dossier : ${report.failed} dossier(s) repris au prochain passage`);
    } catch (error) {
      this.logger.error(`Échéances du dossier en échec : ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
