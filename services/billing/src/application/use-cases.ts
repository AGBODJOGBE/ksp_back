import {
  RegisterContractUseCase,
  ResumeContractUseCase,
  SuspendContractUseCase,
  TerminateContractUseCase,
} from './contracts.use-cases';
import {
  GetBillingSettingsUseCase,
  GetInvoiceUseCase,
  GetMyInvoiceUseCase,
  ListInvoicesUseCase,
  ListMyInvoicesUseCase,
  RecordInvoicePaymentUseCase,
  UpdateBillingSettingsUseCase,
} from './invoices.use-cases';
import { IssueDueInvoicesUseCase, MarkOverdueInvoicesUseCase } from './issuing.use-cases';
import { type BillingDeps } from './ports';

/** Cas d'usage du service (une classe chacun), reliés aux mêmes dépendances. */
export function createUseCases(deps: BillingDeps) {
  return {
    registerContract: new RegisterContractUseCase(deps),
    terminateContract: new TerminateContractUseCase(deps),
    suspendContract: new SuspendContractUseCase(deps),
    resumeContract: new ResumeContractUseCase(deps),
    issueDueInvoices: new IssueDueInvoicesUseCase(deps),
    markOverdueInvoices: new MarkOverdueInvoicesUseCase(deps),
    listMyInvoices: new ListMyInvoicesUseCase(deps),
    getMyInvoice: new GetMyInvoiceUseCase(deps),
    listInvoices: new ListInvoicesUseCase(deps),
    getInvoice: new GetInvoiceUseCase(deps),
    recordInvoicePayment: new RecordInvoicePaymentUseCase(deps),
    getSettings: new GetBillingSettingsUseCase(deps),
    updateSettings: new UpdateBillingSettingsUseCase(deps),
  };
}

export type BillingUseCases = ReturnType<typeof createUseCases>;

/** Jeton d'injection des cas d'usage (racine de composition). */
export const BILLING_USE_CASES = Symbol('BILLING_USE_CASES');
