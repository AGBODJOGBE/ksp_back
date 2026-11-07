import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { FILE_USE_CASES, type FileUseCases } from '../../application/use-cases';

export const PURGE_INTERVAL_MS = Symbol('PURGE_INTERVAL_MS');

/**
 * Purge planifiée (ADR-038) : envois non confirmés, fichiers jamais rattachés, effacement physique
 * des fichiers supprimés. Intervalle 0 : désactivée. Seuls les compteurs sont journalisés.
 */
@Injectable()
export class PurgeFilesService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PurgeFilesService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(FILE_USE_CASES) private readonly useCases: FileUseCases,
    @Inject(PURGE_INTERVAL_MS) private readonly intervalMs: number,
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
      const report = await this.useCases.purgeFiles.execute();
      if (report.expiredPending || report.expiredUnattached || report.erased || report.errors) {
        this.logger.log(
          `Purge : ${report.expiredPending} envoi(s) non confirmé(s), ${report.expiredUnattached} ` +
            `fichier(s) jamais rattaché(s), ${report.erased} effacé(s), ${report.errors} en erreur`,
        );
      }
    } catch (error) {
      this.logger.warn(`Purge interrompue : ${(error as Error).name}`);
    } finally {
      this.running = false;
    }
  }
}
