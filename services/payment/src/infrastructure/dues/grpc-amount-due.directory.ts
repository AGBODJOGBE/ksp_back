import { type billingV1, type cleaningV1, type moneyV1 } from '@ksp/contracts';
import { AppError, type GrpcCaller } from '@ksp/platform';
import { type AmountDueDirectory } from '../../application/ports';
import { PaymentErrors } from '../../application/shared/errors';
import { type InvoiceDue, type MissionDue } from '../../domain/amount-due';

const amount = (value: moneyV1.Money | undefined) => Number(value?.amount ?? 0);

/** Objet inconnu chez le service appelé : null ; panne : erreur (le client réessaie avec sa clé). */
async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof AppError && error.kind === 'NOT_FOUND') return null;
    if (error instanceof AppError && error.kind === 'INVALID_ARGUMENT') throw PaymentErrors.subjectNotFound();
    throw error;
  }
}

/**
 * Montants dus lus dans cleaning (MissionPaymentDueService) et billing (InvoicePaymentDueService),
 * avec le jeton de service de payment (ADR-022) : délai, nouvelle tentative et coupe-circuit du
 * GrpcCaller, un appelant par service. Lectures sans effet : elles peuvent être rejouées.
 */
export class GrpcAmountDueDirectory implements AmountDueDirectory {
  constructor(
    private readonly cleaning: { client: cleaningV1.MissionPaymentDueServiceClient; caller: GrpcCaller },
    private readonly billing: { client: billingV1.InvoicePaymentDueServiceClient; caller: GrpcCaller },
  ) {}

  missionDue(missionId: string): Promise<MissionDue | null> {
    return orNull(async () => {
      const res = await this.cleaning.caller.call(
        'getMissionAmountDue',
        (metadata) => this.cleaning.client.getMissionAmountDue({ missionId }, metadata),
        { idempotent: true },
      );
      return {
        missionId: res.missionId,
        customerId: res.customerId,
        organizationId: res.organizationId || null,
        status: res.status,
        depositDue: amount(res.depositDue),
        remainingDue: amount(res.remainingDue),
      };
    });
  }

  invoiceDue(invoiceId: string): Promise<InvoiceDue | null> {
    return orNull(async () => {
      const res = await this.billing.caller.call(
        'getInvoiceAmountDue',
        (metadata) => this.billing.client.getInvoiceAmountDue({ invoiceId }, metadata),
        { idempotent: true },
      );
      return {
        invoiceId: res.invoiceId,
        number: res.number,
        customerId: res.customerId,
        organizationId: res.organizationId || null,
        status: res.status,
        balance: amount(res.balance),
      };
    });
  }
}
