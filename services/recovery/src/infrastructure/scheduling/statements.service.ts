import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { RECOVERY_USE_CASES, type RecoveryUseCases } from '../../application/use-cases';

export const STATEMENTS_INTERVAL_MS = Symbol('STATEMENTS_INTERVAL_MS');

/**
 * Tâche planifiée des relevés mensuels (R-CO-05, ADR-060 point 17) : dès le 1er du mois, heure du
 * Bénin, un relevé par dossier dont un encaissement a été crédité au créancier le mois écoulé, avec
 * son PDF ; un échec (document, identity) est repris au passage suivant. Plusieurs instances peuvent
 * tourner (un relevé par dossier et par mois, document idempotent). Intervalle 0 : tâche désactivée.
 * Seuls des compteurs sont journalisés.
 */
@Injectable()
export class StatementsService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(StatementsService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(RECOVERY_USE_CASES) private readonly useCases: RecoveryUseCases,
    @Inject(STATEMENTS_INTERVAL_MS) private readonly intervalMs: number,
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
      const report = await this.useCases.issueMonthlyStatements.execute();
      if (report.issued) this.logger.log(`Relevés mensuels : ${report.issued} relevé(s) produit(s)`);
      if (report.failed)
        this.logger.warn(`Relevés mensuels : ${report.failed} dossier(s) repris au prochain passage`);
    } catch (error) {
      this.logger.error(`Relevés mensuels en échec : ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
