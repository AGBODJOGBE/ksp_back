import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { RECOVERY_USE_CASES, type RecoveryUseCases } from '../../application/use-cases';
import { CASE_DEADLINES_INTERVAL_MS } from './case-deadlines.service';

/**
 * Tâche planifiée interne de l'argent (ADR-060, points 6 et 17) : encaissements dont le net n'a pas
 * encore été crédité au créancier ou dont le reçu manque (wallet ou document injoignable), clôtures
 * dont l'attestation, la révocation des liens ou l'événement restent à faire. Même intervalle que la
 * tâche des échéances ; chaque effet est idempotent, plusieurs instances peuvent tourner.
 */
@Injectable()
export class MoneyEffectsService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(MoneyEffectsService.name);
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
      const report = await this.useCases.resumeMoneyEffects.execute();
      if (report.settled || report.closed) {
        this.logger.log(
          `Argent : ${report.settled} encaissement(s) repris, ${report.closed} clôture(s) terminée(s)`,
        );
      }
      if (report.failed) this.logger.warn(`Argent : ${report.failed} effet(s) repris au prochain passage`);
    } catch (error) {
      this.logger.error(`Reprise de l'argent en échec : ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
