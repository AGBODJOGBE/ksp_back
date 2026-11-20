import { type walletV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { type WalletCredits } from '../../application/monthly/ports';

/**
 * Crédit au portefeuille chez wallet (WalletService.Credit, R-WL-04) : part d'un avoir au-delà du
 * reste dû d'une facture (lot F). Idempotent par clé chez wallet : l'appel peut être rejoué.
 * billing doit figurer dans WALLET_CREDIT_CALLERS de wallet.
 */
export class GrpcWalletCredits implements WalletCredits {
  constructor(
    private readonly client: walletV1.WalletServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async credit(input: Parameters<WalletCredits['credit']>[0]): Promise<{ transactionId: string }> {
    const res = await this.caller.call(
      'credit',
      (metadata) =>
        this.client.credit(
          {
            idempotencyKey: input.idempotencyKey,
            holder: input.holder,
            amount: { amount: input.amount, currency: 'XOF' },
            object: { service: '', part: '', ...input.object },
            // Avoir : remboursement sans débit à rembourser en entier (contrat wallet, CreditRequest.kind).
            kind: 'refund',
            description: input.description.slice(0, 140),
            relatedTransactionId: '',
          },
          metadata,
        ),
      { idempotent: true },
    );
    if (!res.transaction?.id) throw new Error('Réponse de wallet sans crédit.');
    return { transactionId: res.transaction.id };
  }
}
