import { type AmicableDeps } from './amicable.ports';
import { WatchAmicableUseCase } from './amicable-tasks.use-case';
import {
  AddInternalNoteUseCase,
  GetMyWorkQueueUseCase,
  RecordContactUseCase,
  RecordPromiseUseCase,
  SendDebtorMessageUseCase,
} from './case-work.use-cases';
import {
  AnswerDecisionUseCase,
  ChangeCaseStageUseCase,
  ListMyDecisionsUseCase,
  ProposeSettlementUseCase,
} from './decisions.use-cases';
import {
  ApprovePaymentPlanUseCase,
  ProposeDebtorPaymentPlanUseCase,
  ProposePaymentPlanUseCase,
  RecordPlanSignatureUseCase,
  ResendDebtorPlanSignatureUseCase,
  SimulateDebtorPaymentPlanUseCase,
} from './payment-plans.use-cases';

/**
 * Cas d'usage de la procédure amiable (lot R4) : « Ma journée », contacts, promesses, notes, messages
 * au débiteur, échéanciers, remises, changements d'étape, décisions du créancier, signature du
 * protocole et tâche planifiée.
 */
export function createAmicableUseCases(deps: AmicableDeps) {
  return {
    getMyWorkQueue: new GetMyWorkQueueUseCase(deps),
    recordContact: new RecordContactUseCase(deps),
    recordPromise: new RecordPromiseUseCase(deps),
    addInternalNote: new AddInternalNoteUseCase(deps),
    sendDebtorMessage: new SendDebtorMessageUseCase(deps),
    proposePaymentPlan: new ProposePaymentPlanUseCase(deps),
    approvePaymentPlan: new ApprovePaymentPlanUseCase(deps),
    proposeSettlement: new ProposeSettlementUseCase(deps),
    changeCaseStage: new ChangeCaseStageUseCase(deps),
    listMyDecisions: new ListMyDecisionsUseCase(deps),
    answerDecision: new AnswerDecisionUseCase(deps),
    simulateDebtorPaymentPlan: new SimulateDebtorPaymentPlanUseCase(deps),
    proposeDebtorPaymentPlan: new ProposeDebtorPaymentPlanUseCase(deps),
    resendDebtorPlanSignature: new ResendDebtorPlanSignatureUseCase(deps),
    recordPlanSignature: new RecordPlanSignatureUseCase(deps),
    watchAmicable: new WatchAmicableUseCase(deps),
  };
}

export type { AmicableDeps, AmicableOptions, AmicableStore, DocumentCancellation } from './amicable.ports';
