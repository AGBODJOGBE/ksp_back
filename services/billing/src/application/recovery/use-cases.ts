import {
  DebitCommissionInvoicesUseCase,
  DEFAULT_DEBIT_RETRY_DELAY_MS,
  GetCommissionInvoiceUseCase,
  GetMyCommissionInvoiceUseCase,
  HasPendingCommissionObligationsUseCase,
  IssueCommissionInvoicesUseCase,
  ListCommissionInvoicesUseCase,
  ListMyCommissionInvoicesUseCase,
  RecordCommissionCollectionUseCase,
} from './commission-invoices.use-cases';
import { ListMyFeeReceiptsUseCase, RecordFeeReceiptUseCase } from './fee-receipts.use-cases';
import { type RecoveryBillingDeps, type RecoveryBillingOptions } from './ports';

/** Cas d'usage de la facturation du recouvrement (ADR-064), reliés aux mêmes dépendances. */
export function createRecoveryBillingUseCases(
  deps: RecoveryBillingDeps,
  options: RecoveryBillingOptions = { debitRetryDelayMs: DEFAULT_DEBIT_RETRY_DELAY_MS },
) {
  return {
    recordCollection: new RecordCommissionCollectionUseCase(deps),
    issueCommissionInvoices: new IssueCommissionInvoicesUseCase(deps),
    debitCommissionInvoices: new DebitCommissionInvoicesUseCase(deps, options),
    listMyCommissionInvoices: new ListMyCommissionInvoicesUseCase(deps),
    getMyCommissionInvoice: new GetMyCommissionInvoiceUseCase(deps),
    listCommissionInvoices: new ListCommissionInvoicesUseCase(deps),
    getCommissionInvoice: new GetCommissionInvoiceUseCase(deps),
    hasPendingObligations: new HasPendingCommissionObligationsUseCase(deps),
    recordFeeReceipt: new RecordFeeReceiptUseCase(deps),
    listMyFeeReceipts: new ListMyFeeReceiptsUseCase(deps),
  };
}

export type RecoveryBillingUseCases = ReturnType<typeof createRecoveryBillingUseCases>;

/** Jeton d'injection des cas d'usage du recouvrement (racine de composition). */
export const RECOVERY_BILLING_USE_CASES = Symbol('RECOVERY_BILLING_USE_CASES');
