import { type billingV1, type cleaningV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { type DebitRecordChecks, type DebitRecordStatus } from '../../application/ports';

/**
 * Objets débités par le Nettoyage v2 (ADR-055) : frais de visite d'une demande, séance. Un débit v1
 * (`cleaning_mission`) n'est plus soumis à cleaning, qui ne le connaît plus (ADR-054).
 */
const CLEANING_OBJECTS: readonly string[] = ['cleaning_visit_fee', 'cleaning_session'];
const STATUSES: readonly string[] = ['recorded', 'not_recorded', 'in_progress'] satisfies DebitRecordStatus[];

/**
 * « Débit enregistré ? » chez cleaning (frais de visite, séance) et billing (facture),
 * WalletDebitCheckService réservé à wallet (ADR-048), avec le jeton de service de wallet. cleaning
 * répond par un statut (RV-80), billing par un booléen. Un autre service ou objet n'est pas couvert :
 * null. Une panne, ou un statut inconnu, lève l'erreur (le débit est relu au passage suivant).
 */
export class GrpcDebitRecordChecks implements DebitRecordChecks {
  constructor(
    private readonly cleaning: { client: cleaningV1.WalletDebitCheckServiceClient; caller: GrpcCaller },
    private readonly billing: { client: billingV1.WalletDebitCheckServiceClient; caller: GrpcCaller },
  ) {}

  async debitStatus(debit: {
    caller: string;
    objectType: string;
    objectId: string;
    transactionId: string;
  }): Promise<DebitRecordStatus | null> {
    const options = { idempotent: true, deadlineMs: 5_000 };
    if (debit.caller === 'cleaning' && CLEANING_OBJECTS.includes(debit.objectType)) {
      const res = await this.cleaning.caller.call(
        'getWalletDebitStatus',
        (metadata) =>
          this.cleaning.client.getWalletDebitStatus(
            { objectType: debit.objectType, objectId: debit.objectId, transactionId: debit.transactionId },
            metadata,
          ),
        options,
      );
      if (!STATUSES.includes(res.status)) {
        throw new Error(`Statut de débit inconnu chez cleaning : « ${res.status} »`);
      }
      return res.status as DebitRecordStatus;
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
      return res.recorded ? 'recorded' : 'not_recorded';
    }
    return null;
  }
}
