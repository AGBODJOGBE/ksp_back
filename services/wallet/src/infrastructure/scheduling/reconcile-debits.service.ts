import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { WALLET_USE_CASES, type WalletUseCases } from '../../application/use-cases';

export const DEBIT_RECONCILE_INTERVAL_MS = Symbol('DEBIT_RECONCILE_INTERVAL_MS');

/**
 * Rapprochement planifié des débits du portefeuille avec cleaning et billing (ADR-048). Intervalle 0 :
 * désactivé. Plusieurs instances peuvent tourner : un remboursement n'est écrit qu'une fois (une
 * seule écriture inverse par débit, contrainte en base).
 */
@Injectable()
export class ReconcileDebitsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ReconcileDebitsService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(WALLET_USE_CASES) private readonly useCases: WalletUseCases,
    @Inject(DEBIT_RECONCILE_INTERVAL_MS) private readonly intervalMs: number,
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
      const result = await this.useCases.reconcileDebits.execute();
      if (result.refunded) {
        this.logger.error(
          `ALERTE wallet : ${result.refunded} débit(s) du portefeuille sans paiement enregistré par le ` +
            'service, remboursé(s) au client ; à vérifier (journal de cleaning ou billing)',
        );
      }
      if (result.examined) {
        this.logger.log(
          `Débits rapprochés : ${result.examined} examinés, ${result.recorded} enregistrés, ` +
            `${result.refunded} remboursés, ${result.errors} en erreur`,
        );
      }
    } catch (error) {
      this.logger.warn(`Rapprochement des débits interrompu : ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
