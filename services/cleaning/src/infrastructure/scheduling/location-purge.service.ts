import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { CLEANING_USE_CASES, type CleaningUseCases } from '../../application/use-cases';

export const LOCATION_PURGE_INTERVAL_MS = Symbol('LOCATION_PURGE_INTERVAL_MS');

/**
 * Tâche planifiée interne, comme la surveillance des impayés : purge des positions GPS des demandes
 * et missions clôturées depuis plus que la durée réglée au back-office (ADR-035). Idempotente et par
 * lots ; plusieurs instances peuvent tourner (SKIP LOCKED). Seuls les nombres sont journalisés.
 * Intervalle 0 : tâche désactivée.
 */
@Injectable()
export class LocationPurgeService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(LocationPurgeService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(CLEANING_USE_CASES) private readonly useCases: CleaningUseCases,
    @Inject(LOCATION_PURGE_INTERVAL_MS) private readonly intervalMs: number,
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
      const { requests, missions } = await this.useCases.purgeLocations.execute();
      if (requests || missions) {
        this.logger.log(`Positions effacées : ${requests} demande(s), ${missions} mission(s)`);
      }
    } catch (error) {
      this.logger.error(`Purge des positions en échec : ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
