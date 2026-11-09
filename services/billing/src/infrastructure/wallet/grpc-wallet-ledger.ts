import { type walletV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { type WalletDebit, type WalletLedger } from '../../application/ports';

/**
 * Portefeuille prépayé chez wallet (WalletService.Debit et Refund, ADR-046), avec le jeton de
 * service de billing ; l'utilisateur de la requête est transmis dans les métadonnées par le kit.
 * Les deux appels sont idempotents chez wallet (clé du débit, remboursement unique) : ils peuvent
 * être rejoués. Les erreurs de wallet (solde insuffisant…) sont transmises telles quelles.
 */
export class GrpcWalletLedger implements WalletLedger {
  constructor(
    private readonly client: walletV1.WalletServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async debit(input: Parameters<WalletLedger['debit']>[0]): Promise<WalletDebit> {
    const res = await this.caller.call(
      'debit',
      (metadata) =>
        this.client.debit(
          {
            idempotencyKey: input.idempotencyKey,
            holder: input.holder,
            amount: { amount: input.amount, currency: 'XOF' },
            object: { service: '', ...input.object },
            description: input.description,
          },
          metadata,
        ),
      { idempotent: true },
    );
    if (!res.transaction?.id) throw new Error('Réponse de wallet sans débit.');
    return {
      transactionId: res.transaction.id,
      amount: Number(res.transaction.amount?.amount ?? 0),
      created: res.created,
    };
  }

  async refund(input: { transactionId: string; reason: string }): Promise<void> {
    await this.caller.call('refund', (metadata) => this.client.refund(input, metadata), { idempotent: true });
  }
}
