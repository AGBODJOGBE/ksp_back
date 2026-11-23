import { type walletV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { type Holder, type WalletGateway } from '../../application/ports';
import { callDependency } from './dependency';

/**
 * Portefeuille chez wallet (WalletService, ADR-042, ADR-046) avec le jeton de service de recovery :
 * débit du portefeuille prépayé (frais de dossier, provisions), encaissement crédité net au créancier
 * avec la commission calculée par recovery (`commission_amount`, ADR-060), annulation par écriture
 * inverse. Tous ces appels sont idempotents chez wallet (clé ou référence) : ils peuvent être rejoués.
 */
export class GrpcWalletGateway implements WalletGateway {
  constructor(
    private readonly client: walletV1.WalletServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async debit(
    input: Parameters<WalletGateway['debit']>[0],
  ): Promise<{ transactionId: string; created: boolean }> {
    const res = await callDependency<walletV1.DebitResponse>(
      'wallet',
      this.caller,
      'debit',
      (metadata) =>
        this.client.debit(
          {
            idempotencyKey: input.idempotencyKey,
            holder: input.holder,
            amount: { amount: input.amount, currency: 'XOF' },
            object: { service: 'recovery', objectType: input.objectType, objectId: input.objectId, part: '' },
            description: input.description,
          },
          metadata,
        ),
      { idempotent: true },
    );
    if (!res.transaction?.id) throw new Error('Réponse de wallet sans débit.');
    return { transactionId: res.transaction.id, created: res.created };
  }

  async refund(input: { debitTransactionId: string; reason: string }): Promise<{ transactionId: string }> {
    const res = await callDependency<walletV1.RefundResponse>(
      'wallet',
      this.caller,
      'refund',
      (metadata) =>
        this.client.refund({ transactionId: input.debitTransactionId, reason: input.reason }, metadata),
      { idempotent: true },
    );
    if (!res.transaction?.id) throw new Error('Réponse de wallet sans remboursement.');
    return { transactionId: res.transaction.id };
  }

  async recordCollection(
    input: Parameters<WalletGateway['recordCollection']>[0],
  ): Promise<{ transactionId: string; created: boolean }> {
    const res = await callDependency<walletV1.RecordCollectionResponse>(
      'wallet',
      this.caller,
      'recordCollection',
      (metadata) =>
        this.client.recordCollection(
          {
            holder: input.holder,
            grossAmount: { amount: input.gross, currency: 'XOF' },
            commissionRateBps: input.commissionRateBps,
            commissionAmount: { amount: input.commission, currency: 'XOF' },
            reference: input.reference,
            description: input.description,
          },
          metadata,
        ),
      { idempotent: true },
    );
    if (!res.transaction?.id) throw new Error('Réponse de wallet sans encaissement.');
    return { transactionId: res.transaction.id, created: res.created };
  }

  async reverseCollection(input: {
    transactionId: string;
    reference: string;
    reason: string;
  }): Promise<{ transactionId: string }> {
    const res = await callDependency<walletV1.ReverseTransactionResponse>(
      'wallet',
      this.caller,
      'reverseTransaction',
      (metadata) => this.client.reverseTransaction(input, metadata),
      { idempotent: true },
    );
    if (!res.transaction?.id) throw new Error('Réponse de wallet sans annulation.');
    return { transactionId: res.transaction.id };
  }

  async balance(holder: Holder): Promise<{ balance: number; prepaidBalance: number }> {
    const res = await callDependency<walletV1.GetBalanceResponse>(
      'wallet',
      this.caller,
      'getBalance',
      (metadata) => this.client.getBalance({ holder }, metadata),
      { idempotent: true },
    );
    return {
      balance: Number(res.wallet?.balance?.amount ?? 0),
      prepaidBalance: Number(res.wallet?.prepaid?.balance?.amount ?? 0),
    };
  }
}
