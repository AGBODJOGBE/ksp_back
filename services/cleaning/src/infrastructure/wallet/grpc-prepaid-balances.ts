import { type walletV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { type PrepaidBalances, type WalletHolder } from '../../application/money/money.ports';

/**
 * Solde prépayé disponible chez wallet (GetPrepaidBalance, jeton de service) : solde moins les
 * retraits en cours (R-WL-04). Lecture rejouable.
 */
export class GrpcPrepaidBalances implements PrepaidBalances {
  constructor(
    private readonly client: walletV1.WalletServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async available(holder: WalletHolder): Promise<number> {
    const response = await this.caller.call(
      'getPrepaidBalance',
      (metadata) => this.client.getPrepaidBalance({ holder }, metadata),
      { idempotent: true },
    );
    const balance = Number(response.wallet?.balance?.amount ?? 0);
    const withdrawing = Number(response.wallet?.withdrawalsInProgress?.amount ?? 0);
    return Math.max(0, balance - withdrawing);
  }
}
