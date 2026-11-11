import { type billingV1, type cleaningV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { type DebitRecordChecks } from '../../application/ports';

/**
 * « Débit enregistré ? » chez cleaning (mission) et billing (facture), WalletDebitCheckService
 * réservé à wallet (ADR-048), avec le jeton de service de wallet. Un autre service ou objet n'est
 * pas couvert : null. Une panne lève l'erreur (le débit est relu au passage suivant).
 */
export class GrpcDebitRecordChecks implements DebitRecordChecks {
  constructor(
    private readonly cleaning: { client: cleaningV1.WalletDebitCheckServiceClient; caller: GrpcCaller },
    private readonly billing: { client: billingV1.WalletDebitCheckServiceClient; caller: GrpcCaller },
  ) {}

  async isRecorded(debit: {
    caller: string;
    objectType: string;
    objectId: string;
    transactionId: string;
  }): Promise<boolean | null> {
    const options = { idempotent: true, deadlineMs: 5_000 };
    if (debit.caller === 'cleaning' && debit.objectType === 'cleaning_mission') {
      const res = await this.cleaning.caller.call(
        'getWalletDebitStatus',
        (metadata) =>
          this.cleaning.client.getWalletDebitStatus(
            { missionId: debit.objectId, transactionId: debit.transactionId },
            metadata,
          ),
        options,
      );
      return res.recorded;
    }
    if (debit.caller === 'billing' && debit.objectType === 'billing_invoice') {
      const res = await this.billing.caller.call(
        'getWalletDebitStatus',
        (metadata) =>
          this.billing.client.getWalletDebitStatus(
            { invoiceId: debit.objectId, transactionId: debit.transactionId },
            metadata,
          ),
        options,
      );
      return res.recorded;
    }
    return null;
  }
}
