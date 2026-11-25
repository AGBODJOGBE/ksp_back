import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { RECOVERY_USE_CASES, type RecoveryUseCases } from '../../application/use-cases';

export const CASE_DEADLINES_INTERVAL_MS = Symbol('CASE_DEADLINES_INTERVAL_MS');

/**
 * Tâche planifiée interne : échéances des dossiers (ADR-060, point 17) — brouillons non payés
 * supprimés (R-SD-04), dossiers sans complément classés (4.4), remboursements et forfaits d'étude
 * repris. Plusieurs instances peuvent tourner : chaque écriture est conditionnée par la version du
 * dossier, chaque appel à wallet est idempotent. Intervalle 0 : tâche désactivée.
 */
@Injectable()
export class CaseDeadlinesService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(CaseDeadlinesService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(RECOVERY_USE_CASES) private readonly useCases: RecoveryUseCases,
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

  /** Un seul passage à la fois ; les erreurs sont journalisées sans arrêter la tâche. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const report = await this.useCases.watchCaseDeadlines.execute();
      if (report.deleted || report.reconciled || report.closed || report.settled) {
        this.logger.log(
          `Échéances des dossiers : ${report.deleted} supprimé(s), ${report.reconciled} paiement(s) rapproché(s), ` +
            `${report.closed} classé(s), ${report.settled} remboursement(s) repris`,
        );
      }
      if (report.failed)
        this.logger.warn(`Échéances des dossiers : ${report.failed} dossier(s) repris au prochain passage`);
    } catch (error) {
      this.logger.error(`Échéances des dossiers en échec : ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
