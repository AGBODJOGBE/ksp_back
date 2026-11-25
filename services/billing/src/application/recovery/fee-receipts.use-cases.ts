import { type WalletEventPayloads } from '@ksp/contracts';
import { caseNumberIn, type FeeReceipt, feeReceiptKind, feeReceiptYear } from '../../domain/fee-receipt';
import { type PageRequest, type PageResult } from '../ports';
import { currentCustomer } from '../shared/access';
import { optionalUuid } from '../shared/validation';
import { RECOVERY_EVENTS_CONSUMER } from './commission-invoices.use-cases';
import { type RecoveryBillingDeps } from './ports';

/**
 * Débit du portefeuille prépayé (`wallet.prepaid.debited`) : un reçu pour chaque débit de frais de
 * dossier ou de forfait d'étude fait par recovery (objets `recovery_case_fee`, `recovery_study_fee`),
 * idempotent par transaction du portefeuille. Tout autre débit est ignoré. Un remboursement ultérieur
 * n'annule pas le reçu (ADR-064).
 */
export class RecordFeeReceiptUseCase {
  constructor(private readonly deps: RecoveryBillingDeps) {}

  async execute(input: {
    eventId: string;
    payload: WalletEventPayloads['wallet.prepaid.debited'];
  }): Promise<'recorded' | 'duplicate' | 'ignored'> {
    const { payload } = input;
    const kind = feeReceiptKind(payload);
    if (!kind) return 'ignored';
    const paidAt = new Date(payload.debitedAt);
    const receipt: Omit<FeeReceipt, 'number'> = {
      id: this.deps.ids.next(),
      kind,
      payer: { type: payload.holder.type, id: payload.holder.id.toLowerCase() },
      caseId: payload.objectId.toLowerCase(),
      caseNumber: caseNumberIn(payload.description),
      label: payload.description,
      amount: payload.amount.amount,
      walletTransactionId: payload.transactionId.toLowerCase(),
      paidAt,
      issuedAt: this.deps.clock.now(),
    };
    return this.deps.recovery.recordFeeReceipt(receipt, feeReceiptYear(paidAt), {
      eventId: input.eventId,
      consumer: `${RECOVERY_EVENTS_CONSUMER}.wallet.prepaid.debited`,
    });
  }
}

/** Reçus des frais du client : son compte, ou son organisation active (tout membre). */
export class ListMyFeeReceiptsUseCase {
  constructor(private readonly deps: RecoveryBillingDeps) {}

  async execute(input: { page: PageRequest; caseId: string }): Promise<PageResult<FeeReceipt>> {
    const scope = currentCustomer();
    const caseId = optionalUuid('caseId', input.caseId);
    return this.deps.recovery.listFeeReceipts(
      {
        payer: scope.organizationId
          ? { type: 'organization', id: scope.organizationId.toLowerCase() }
          : { type: 'user', id: scope.userId.toLowerCase() },
        ...(caseId ? { caseId } : {}),
      },
      input.page,
    );
  }
}
