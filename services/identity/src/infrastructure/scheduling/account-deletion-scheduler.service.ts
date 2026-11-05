import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { AnonymizeDueAccountsUseCase } from '../../application/deletion/account-deletion.use-cases';

export const ACCOUNT_DELETION_INTERVAL_MS = Symbol('ACCOUNT_DELETION_INTERVAL_MS');

/**
 * Tâche planifiée interne : anonymisation des comptes dont le délai de suppression est échu
 * (UC-ID-11, ADR-036). Idempotente (anonymisation conditionnelle, par lots) : plusieurs instances
 * peuvent tourner. Intervalle 0 : tâche désactivée. Un report (obligation apparue pendant le délai)
 * ou un contrôle impossible est signalé dans les journaux, sans coordonnées : identifiant du compte
 * et nature des obligations seulement.
 */
@Injectable()
export class AccountDeletionSchedulerService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(AccountDeletionSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly anonymizeDueAccounts: AnonymizeDueAccountsUseCase,
    @Inject(ACCOUNT_DELETION_INTERVAL_MS) private readonly intervalMs: number,
  ) {}

  onApplicationBootstrap(): void {
    if (this.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  beforeApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Un seul passage à la fois ; une erreur est journalisée sans arrêter la tâche. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const run = await this.anonymizeDueAccounts.execute();
      for (const { userId, obstacles } of run.postponed) {
        const kinds = [...new Set(obstacles.map((obstacle) => `${obstacle.service}:${obstacle.kind}`))];
        this.logger.warn(`Suppression du compte ${userId} reportée : ${kinds.join(', ')}.`);
      }
      for (const { userId, services } of run.unchecked) {
        this.logger.warn(
          `Suppression du compte ${userId} reportée, services injoignables : ${services.join(', ')}.`,
        );
      }
      if (run.anonymized.length > 0) this.logger.log(`Comptes anonymisés : ${run.anonymized.length}.`);
    } catch (error) {
      this.logger.error(`Anonymisation en échec, reprise au prochain passage : ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
