import {
  CancelInvoiceUseCase,
  IssueAdminCreditNoteUseCase,
  IssueCreditNoteUseCase,
  ListInvoiceCreditNotesUseCase,
} from './credit-notes.use-cases';
import {
  CountOrganizationUnpaidInvoicesUseCase,
  IssueMonthlyInvoicesUseCase,
  MarkMonthlyInvoicesOverdueUseCase,
  RecordBillableSessionUseCase,
  SendInvoiceRemindersUseCase,
} from './monthly-invoices.use-cases';
import { type MonthlyBillingDeps } from './ports';
import { SettleInvoiceFromWalletCreditUseCase } from './settlement.use-cases';

/** Cas d'usage du lot F (facture mensuelle des organisations), reliés aux mêmes dépendances. */
export function createMonthlyUseCases(deps: MonthlyBillingDeps) {
  return {
    recordBillableSession: new RecordBillableSessionUseCase(deps),
    issueMonthlyInvoices: new IssueMonthlyInvoicesUseCase(deps),
    markMonthlyInvoicesOverdue: new MarkMonthlyInvoicesOverdueUseCase(deps),
    sendInvoiceReminders: new SendInvoiceRemindersUseCase(deps),
    countOrganizationUnpaidInvoices: new CountOrganizationUnpaidInvoicesUseCase(deps),
    issueCreditNote: new IssueCreditNoteUseCase(deps),
    issueAdminCreditNote: new IssueAdminCreditNoteUseCase(deps),
    listInvoiceCreditNotes: new ListInvoiceCreditNotesUseCase(deps),
    cancelInvoice: new CancelInvoiceUseCase(deps),
    settleInvoiceFromWalletCredit: new SettleInvoiceFromWalletCreditUseCase(deps),
  };
}

export type MonthlyBillingUseCases = ReturnType<typeof createMonthlyUseCases>;

/** Jeton d'injection des cas d'usage du lot F (racine de composition). */
export const MONTHLY_USE_CASES = Symbol('MONTHLY_USE_CASES');
