import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { CLEANING_DEPS, type CleaningDeps, type PrivacyDeps } from '../../application/deps';
import { PurgeExpiredDataUseCase } from '../../application/privacy/retention.use-case';

export const RETENTION_PURGE_INTERVAL_MS = Symbol('RETENTION_PURGE_INTERVAL_MS');

/**
 * Tâche planifiée interne de conservation (UC-NT-48, R-DP-01, RV-13), sur le modèle de la v1 : un
 * seul passage à la fois dans l'instance, `unref`, intervalle 0 = désactivée, erreurs journalisées
 * sans arrêter la tâche. Entre répliques, le verrou consultatif du dépôt laisse passer une seule
 * instance ; chaque écriture reste conditionnée (position ou photo encore présente, durée écoulée).
 * Journal : des nombres seulement, jamais d'identifiant ni de position.
 */
@Injectable()
export class RetentionPurgeService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(RetentionPurgeService.name);
  private readonly purge: PurgeExpiredDataUseCase;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(CLEANING_DEPS) deps: CleaningDeps,
    @Inject(RETENTION_PURGE_INTERVAL_MS) private readonly intervalMs: number,
  ) {
    this.purge = new PurgeExpiredDataUseCase(deps as PrivacyDeps, (step, error) =>
      this.logger.warn(`Conservation, étape ${step} en échec : ${(error as Error).message}`),
    );
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
      const report = await this.purge.execute();
      const arrivals = report.visitArrivals + report.sessionArrivals;
      const erased = report.requestLocations + report.placeLocations + arrivals + report.photos;
      if (erased || report.idempotencyRecords) {
        this.logger.log(
          `Conservation : ${report.requestLocations} demande(s), ${report.placeLocations} lieu(x), ` +
            `${arrivals} position(s) d'arrivée et ${report.photos} photo(s) effacés ; ` +
            `${report.idempotencyRecords} clé(s) d'idempotence supprimée(s)`,
        );
      }
      if (report.failed) {
        this.logger.warn(`Conservation : ${report.failed} élément(s) repris au prochain passage`);
      }
    } catch (error) {
      this.logger.error(`Conservation en échec : ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
