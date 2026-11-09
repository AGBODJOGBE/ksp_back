import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { DOCUMENT_USE_CASES, type DocumentUseCases } from '../../application/use-cases';

export const EXPIRY_INTERVAL_MS = Symbol('EXPIRY_INTERVAL_MS');

/**
 * Clôture planifiée des demandes de signature expirées (ADR-044) : statut enregistré, coordonnées
 * en clair effacées. Intervalle 0 : désactivée. Seuls les compteurs sont journalisés.
 */
@Injectable()
export class ExpireSignaturesService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ExpireSignaturesService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(DOCUMENT_USE_CASES) private readonly useCases: DocumentUseCases,
    @Inject(EXPIRY_INTERVAL_MS) private readonly intervalMs: number,
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
      const { expired } = await this.useCases.expireSignatures.execute();
      if (expired > 0) this.logger.log(`${expired} demande(s) de signature expirée(s)`);
    } catch (error) {
      this.logger.warn(`Clôture des demandes interrompue : ${(error as Error).name}`);
    } finally {
      this.running = false;
    }
  }
}
