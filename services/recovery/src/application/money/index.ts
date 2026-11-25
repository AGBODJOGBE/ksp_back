import {
  CompleteDebtorUploadUseCase,
  CreateDebtorPaymentUseCase,
  CreateDebtorUploadUseCase,
  GetDebtorCaseUseCase,
  GetDebtorDocumentUrlUseCase,
  RequestDebtorCallbackUseCase,
} from '../debtor-space/debtor-space.use-cases';
import { DisputeDebtorCaseUseCase, ResolveDisputeUseCase } from '../debtor-space/disputes.use-cases';
import { CaseClosure } from './case-closure.service';
import { CollectionService } from './collections.service';
import {
  AddCaseMoneyUseCase,
  DeclareDirectPaymentUseCase,
  ListMyRemittancesUseCase,
  RecordLinkPaymentUseCase,
  RecordOverpaymentRefundUseCase,
  ResumeMoneyEffectsUseCase,
} from './money.use-cases';
import { type MoneyDeps } from './money-rules';
import {
  ApproveOfflinePaymentUseCase,
  ListOfflinePaymentsUseCase,
  OfflinePayments,
  RecordOfflinePaymentUseCase,
  RejectOfflinePaymentUseCase,
} from './offline-payments.use-cases';

/**
 * Cas d'usage de l'argent et de l'espace du débiteur (lot R3), et ses services réutilisables par R4,
 * R5 et billing : `collections` (tout encaissement), `closure` (clôture d'un dossier),
 * `offlinePayments` (validation à deux d'une somme déclarée).
 */
export function createMoneyUseCases(deps: MoneyDeps) {
  return {
    collections: new CollectionService(deps),
    closure: new CaseClosure(deps),
    offlinePayments: new OfflinePayments(deps),
    getDebtorCase: new GetDebtorCaseUseCase(deps),
    createDebtorPayment: new CreateDebtorPaymentUseCase(deps),
    disputeDebtorCase: new DisputeDebtorCaseUseCase(deps),
    createDebtorUpload: new CreateDebtorUploadUseCase(deps),
    completeDebtorUpload: new CompleteDebtorUploadUseCase(deps),
    requestDebtorCallback: new RequestDebtorCallbackUseCase(deps),
    getDebtorDocumentUrl: new GetDebtorDocumentUrlUseCase(deps),
    declareDirectPayment: new DeclareDirectPaymentUseCase(deps),
    listMyRemittances: new ListMyRemittancesUseCase(deps),
    resolveDispute: new ResolveDisputeUseCase(deps),
    recordOfflinePayment: new RecordOfflinePaymentUseCase(deps),
    listOfflinePayments: new ListOfflinePaymentsUseCase(deps),
    approveOfflinePayment: new ApproveOfflinePaymentUseCase(deps),
    rejectOfflinePayment: new RejectOfflinePaymentUseCase(deps),
    recordOverpaymentRefund: new RecordOverpaymentRefundUseCase(deps),
    recordLinkPayment: new RecordLinkPaymentUseCase(deps),
    resumeMoneyEffects: new ResumeMoneyEffectsUseCase(deps),
    addCaseMoney: new AddCaseMoneyUseCase(deps),
  };
}

export type { MoneyDeps } from './money-rules';
