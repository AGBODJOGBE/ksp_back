import { AssignPartnerUseCase, WithdrawPartnerUseCase } from './assignments.use-cases';
import { CloseCaseUseCase, StopCaseUseCase } from './closures.use-cases';
import { RequestEscalationUseCase } from './escalations.use-cases';
import { ExportCaseJournalUseCase } from './evidence-log.use-cases';
import { IssueFormalNoticeUseCase, RecordNoticeDeliveryUseCase } from './formal-notices.use-cases';
import { type LitigationDeps } from './litigation.ports';
import { WatchLitigationUseCase } from './litigation-tasks.use-case';
import {
  DeclarePartnerCollectionUseCase,
  GetMyAssignmentUseCase,
  ListMyAssignmentsUseCase,
  RecordLegalActUseCase,
} from './partner-access.use-cases';
import {
  CreatePartnerUseCase,
  GetPartnerUseCase,
  ListPartnersUseCase,
  SuggestPartnersUseCase,
  UpdatePartnerUseCase,
} from './partners.use-cases';

/**
 * Cas d'usage du contentieux (lot R5) : arrêt et clôture, mise en demeure, devis des étapes payantes,
 * partenaires (référentiel, propositions, assignation, retrait), accès du partenaire (dossiers, actes,
 * encaissements), journal de preuve exporté et tâche planifiée. Les réponses du créancier aux devis
 * passent par AnswerDecision (lot R4), qui les confie à `EscalationDecisionsService`.
 */
export function createLitigationUseCases(deps: LitigationDeps) {
  return {
    stopCase: new StopCaseUseCase(deps),
    closeCase: new CloseCaseUseCase(deps),
    issueFormalNotice: new IssueFormalNoticeUseCase(deps),
    recordNoticeDelivery: new RecordNoticeDeliveryUseCase(deps),
    requestEscalation: new RequestEscalationUseCase(deps),
    suggestPartners: new SuggestPartnersUseCase(deps),
    assignPartner: new AssignPartnerUseCase(deps),
    withdrawPartner: new WithdrawPartnerUseCase(deps),
    exportCaseJournal: new ExportCaseJournalUseCase(deps),
    listPartners: new ListPartnersUseCase(deps),
    getPartner: new GetPartnerUseCase(deps),
    createPartner: new CreatePartnerUseCase(deps),
    updatePartner: new UpdatePartnerUseCase(deps),
    listMyAssignments: new ListMyAssignmentsUseCase(deps),
    getMyAssignment: new GetMyAssignmentUseCase(deps),
    recordLegalAct: new RecordLegalActUseCase(deps),
    declarePartnerCollection: new DeclarePartnerCollectionUseCase(deps),
    watchLitigation: new WatchLitigationUseCase(deps),
  };
}

export { EscalationDecisionsService } from './escalations.use-cases';
export type { EscalationDecisions } from './escalation.port';
export type { LitigationDeps, LitigationStore } from './litigation.ports';
