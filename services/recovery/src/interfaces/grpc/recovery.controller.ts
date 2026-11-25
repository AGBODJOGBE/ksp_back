import { type Metadata } from '@grpc/grpc-js';
import { recoveryV1 } from '@ksp/contracts';
import { Controller, Inject } from '@nestjs/common';
import { type DebtorSessionScope } from '../../application/debtor-access/debtor-access.use-cases';
import { RECOVERY_USE_CASES, type RecoveryUseCases } from '../../application/use-cases';
import { debtorSessionToken } from './debtor-session';
import {
  caseInputOf,
  importValuesOf,
  preferencesOf,
  presentCase,
  presentDashboard,
  presentDocument,
  presentImport,
  presentJournal,
  presentOverview,
  presentPreferences,
  presentScoreFactors,
  presentSummary,
} from './case-presenters';
import {
  presentDecision,
  presentPlan,
  presentPromise,
  presentSettlement,
  presentSimulation,
  presentWorkItem,
  termsInputOf,
} from './amicable-presenters';
import {
  presentCollection,
  presentDebtorCase,
  presentDispute,
  presentMoneyCase,
  presentOfflinePayment,
  presentRemittance,
} from './money-presenters';
import { notImplemented } from './not-implemented';
import {
  amountOf,
  money,
  presentPricingResult,
  presentPricingRule,
  presentSettings,
  pricingInputOf,
  settingsOf,
} from './presenters';

// Adaptateurs gRPC des quatre services du contrat (ADR-060) : aucune règle métier ici. R1 livre la
// tarification, les réglages, les jours fériés et l'estimation des frais ; R2 les dossiers, l'import,
// les préférences et la recevabilité ; R3 l'argent et l'espace du débiteur ; les autres méthodes
// répondent « pas encore disponible » jusqu'à leur branche (R4, R5).

@Controller()
@recoveryV1.RecoveryCreditorServiceControllerMethods()
export class RecoveryCreditorGrpcController implements recoveryV1.RecoveryCreditorServiceController {
  constructor(@Inject(RECOVERY_USE_CASES) private readonly useCases: RecoveryUseCases) {}

  async estimateCaseFees(
    request: recoveryV1.EstimateCaseFeesRequest,
  ): Promise<recoveryV1.EstimateCaseFeesResponse> {
    const estimate = await this.useCases.estimateCaseFees.execute({
      kind: request.kind,
      amountDue: amountOf('amountDue', request.amountDue) ?? 0,
      communeKey: request.communeKey || null,
    });
    return {
      caseFee: money(estimate.caseFee),
      commissionSummary: estimate.commissionSummary,
      stageRates: estimate.stageRates,
      minimumAmountDue: money(estimate.minimumAmountDue),
      pricing: {
        feeRuleId: estimate.feeRule.id,
        feeRuleVersion: estimate.feeRule.version,
        commissionRuleId: estimate.commissionRule.id,
        commissionRuleVersion: estimate.commissionRule.version,
        commissionSummary: estimate.commissionSummary,
      },
    };
  }

  // Dossiers (R2) : brouillon, pièces, mandat, frais, suivi, import.

  async createCase(request: recoveryV1.CreateCaseRequest): Promise<recoveryV1.CreateCaseResponse> {
    const result = await this.useCases.createCase.execute({
      idempotencyKey: request.idempotencyKey,
      input: caseInputOf(request.input),
    });
    return {
      case: presentCase(result.view),
      possibleDuplicates: result.duplicates.map(presentSummary),
      created: result.created,
    };
  }

  async updateCase(request: recoveryV1.UpdateCaseRequest): Promise<recoveryV1.UpdateCaseResponse> {
    const view = await this.useCases.updateCase.execute({
      caseId: request.caseId,
      input: caseInputOf(request.input),
      completionNote: request.completionNote,
    });
    return { case: presentCase(view) };
  }

  async addCaseDocument(
    request: recoveryV1.AddCaseDocumentRequest,
  ): Promise<recoveryV1.AddCaseDocumentResponse> {
    const document = await this.useCases.addCaseDocument.execute(request);
    return { document: presentDocument(document) };
  }

  async prepareMandate(
    request: recoveryV1.PrepareMandateRequest,
  ): Promise<recoveryV1.PrepareMandateResponse> {
    const result = await this.useCases.prepareMandate.execute(request);
    return {
      case: presentCase(result.view),
      documentId: result.documentId,
      signatureRequestId: result.signatureRequestId,
    };
  }

  async payCaseFee(request: recoveryV1.PayCaseFeeRequest): Promise<recoveryV1.PayCaseFeeResponse> {
    return { case: presentCase(await this.useCases.payCaseFee.execute(request)) };
  }

  async listMyCases(request: recoveryV1.ListMyCasesRequest): Promise<recoveryV1.ListMyCasesResponse> {
    const result = await this.useCases.listMyCases.execute({
      statuses: request.filter?.statuses ?? [],
      stages: request.filter?.stages ?? [],
      kinds: request.filter?.kinds ?? [],
      search: request.filter?.search ?? '',
      ...(request.page ? { page: request.page } : {}),
    });
    return {
      cases: result.items.map(presentSummary),
      nextCursor: result.nextCursor ?? '',
      total: result.total,
    };
  }

  async getMyCase(request: recoveryV1.GetMyCaseRequest): Promise<recoveryV1.GetMyCaseResponse> {
    const view = await this.useCases.getMyCase.execute(request);
    return { case: presentMoneyCase(await this.useCases.addCaseMoney.execute(view)) };
  }

  async listMyCaseJournal(
    request: recoveryV1.ListMyCaseJournalRequest,
  ): Promise<recoveryV1.ListMyCaseJournalResponse> {
    const view = await this.useCases.listMyCaseJournal.execute({
      caseId: request.caseId,
      ...(request.page ? { page: request.page } : {}),
    });
    return { entries: presentJournal(view), nextCursor: view.nextCursor ?? '' };
  }

  async createCaseImport(
    request: recoveryV1.CreateCaseImportRequest,
  ): Promise<recoveryV1.CreateCaseImportResponse> {
    return { import: presentImport(await this.useCases.createCaseImport.execute(request)) };
  }

  async getCaseImport(request: recoveryV1.GetCaseImportRequest): Promise<recoveryV1.GetCaseImportResponse> {
    return { import: presentImport(await this.useCases.getCaseImport.execute(request)) };
  }

  async updateCaseImportLine(
    request: recoveryV1.UpdateCaseImportLineRequest,
  ): Promise<recoveryV1.UpdateCaseImportLineResponse> {
    const view = await this.useCases.updateCaseImportLine.execute({
      importId: request.importId,
      row: request.row,
      values: importValuesOf(request.values),
      ignore: request.ignore,
    });
    return { import: presentImport(view) };
  }

  async confirmCaseImport(
    request: recoveryV1.ConfirmCaseImportRequest,
  ): Promise<recoveryV1.ConfirmCaseImportResponse> {
    return { import: presentImport(await this.useCases.confirmCaseImport.execute(request)) };
  }

  // Décisions du créancier (R4) : échéancier hors barème, remise, saut d'étape, contestation.

  async listMyDecisions(
    request: recoveryV1.ListMyDecisionsRequest,
  ): Promise<recoveryV1.ListMyDecisionsResponse> {
    const result = await this.useCases.listMyDecisions.execute({
      statuses: request.statuses,
      caseId: request.caseId,
      ...(request.page ? { page: request.page } : {}),
    });
    return { decisions: result.items.map(presentDecision), nextCursor: result.nextCursor ?? '' };
  }

  async answerDecision(
    request: recoveryV1.AnswerDecisionRequest,
  ): Promise<recoveryV1.AnswerDecisionResponse> {
    const result = await this.useCases.answerDecision.execute(request);
    return { decision: presentDecision(result.decision), case: presentCase(result.view) };
  }

  stopCase(): Promise<recoveryV1.StopCaseResponse> {
    return notImplemented('StopCase');
  }

  // Argent (R3) : paiement reçu directement, reversements.

  async declareDirectPayment(
    request: recoveryV1.DeclareDirectPaymentRequest,
  ): Promise<recoveryV1.DeclareDirectPaymentResponse> {
    const result = await this.useCases.declareDirectPayment.execute({
      caseId: request.caseId,
      idempotencyKey: request.idempotencyKey,
      amount: amountOf('amount', request.amount),
      receivedOn: request.receivedOn,
      note: request.note,
      proofFileId: request.proofFileId,
    });
    return { case: presentMoneyCase(result.view), collection: presentCollection(result.collection) };
  }

  async listMyRemittances(
    request: recoveryV1.ListMyRemittancesRequest,
  ): Promise<recoveryV1.ListMyRemittancesResponse> {
    const result = await this.useCases.listMyRemittances.execute({
      caseId: request.caseId,
      from: request.from,
      to: request.to,
      ...(request.page ? { page: request.page } : {}),
    });
    return { remittances: result.items.map(presentRemittance), nextCursor: result.nextCursor ?? '' };
  }

  listMyStatements(): Promise<recoveryV1.ListMyStatementsResponse> {
    return notImplemented('ListMyStatements');
  }

  async getMyDashboard(): Promise<recoveryV1.GetMyDashboardResponse> {
    return presentDashboard(await this.useCases.getMyDashboard.execute());
  }

  async getMyPreferences(): Promise<recoveryV1.GetMyPreferencesResponse> {
    return { preferences: presentPreferences(await this.useCases.getMyPreferences.execute()) };
  }

  async updateMyPreferences(
    request: recoveryV1.UpdateMyPreferencesRequest,
  ): Promise<recoveryV1.UpdateMyPreferencesResponse> {
    const stored = await this.useCases.updateMyPreferences.execute(preferencesOf(request.preferences));
    return { preferences: presentPreferences(stored) };
  }
}

/**
 * Débiteur sans compte (ADR-061) : le jeton du lien ouvre l'accès et le code ; les autres méthodes
 * portent la session (métadonnée x-debtor-session), vérifiée avant tout le reste. Ni le jeton, ni le
 * code, ni la session ne sont journalisés.
 */
@Controller()
@recoveryV1.RecoveryDebtorServiceControllerMethods()
export class RecoveryDebtorGrpcController implements recoveryV1.RecoveryDebtorServiceController {
  constructor(@Inject(RECOVERY_USE_CASES) private readonly useCases: RecoveryUseCases) {}

  async openDebtorAccess(
    request: recoveryV1.OpenDebtorAccessRequest,
  ): Promise<recoveryV1.OpenDebtorAccessResponse> {
    const access = await this.useCases.openDebtorAccess.execute({ token: request.token });
    return {
      creditorName: access.creditorName,
      phoneMasked: access.contactMasked,
      linkExpiresAt: access.linkExpiresAt.toISOString(),
    };
  }

  async sendDebtorAccessCode(
    request: recoveryV1.SendDebtorAccessCodeRequest,
  ): Promise<recoveryV1.SendDebtorAccessCodeResponse> {
    const sent = await this.useCases.sendDebtorAccessCode.execute({ token: request.token });
    return {
      channel: sent.channel,
      codeExpiresAt: sent.codeExpiresAt.toISOString(),
      retryAfterSeconds: sent.retryAfterSeconds,
    };
  }

  async verifyDebtorAccessCode(
    request: recoveryV1.VerifyDebtorAccessCodeRequest,
  ): Promise<recoveryV1.VerifyDebtorAccessCodeResponse> {
    const session = await this.useCases.verifyDebtorAccessCode.execute({
      token: request.token,
      code: request.code,
    });
    return { sessionToken: session.sessionToken, sessionExpiresAt: session.sessionExpiresAt.toISOString() };
  }

  async endDebtorSession(
    _request: recoveryV1.EndDebtorSessionRequest,
    metadata?: Metadata,
  ): Promise<recoveryV1.EndDebtorSessionResponse> {
    const ended = await this.useCases.endDebtorSession.execute({
      sessionToken: debtorSessionToken(metadata),
    });
    return { endedAt: ended.endedAt.toISOString() };
  }

  // Méthodes de la session : une session invalide est refusée avant tout le reste ; chaque cas d'usage
  // reçoit le dossier et le débiteur de la session (R3 : situation, paiement, contestation, pièces,
  // rappel, documents ; R4 : échéancier).

  async getDebtorCase(
    _request: recoveryV1.GetDebtorCaseRequest,
    metadata?: Metadata,
  ): Promise<recoveryV1.GetDebtorCaseResponse> {
    const { caseId, debtorId } = await this.debtorSession(metadata);
    return { case: presentDebtorCase(await this.useCases.getDebtorCase.execute({ caseId, debtorId })) };
  }

  async createDebtorPayment(
    request: recoveryV1.CreateDebtorPaymentRequest,
    metadata?: Metadata,
  ): Promise<recoveryV1.CreateDebtorPaymentResponse> {
    const { caseId, debtorId } = await this.debtorSession(metadata);
    const link = await this.useCases.createDebtorPayment.execute({
      caseId,
      debtorId,
      idempotencyKey: request.idempotencyKey,
      amount: amountOf('amount', request.amount),
      settlementId: request.settlementId,
    });
    return { paymentUrl: link.url, amount: money(link.amount), expiresAt: link.expiresAt.toISOString() };
  }

  // Échéancier du débiteur (R4) : simulation, proposition, nouveau lien de signature.

  async simulateDebtorPaymentPlan(
    request: recoveryV1.SimulateDebtorPaymentPlanRequest,
    metadata?: Metadata,
  ): Promise<recoveryV1.SimulateDebtorPaymentPlanResponse> {
    const { caseId } = await this.debtorSession(metadata);
    const simulation = await this.useCases.simulateDebtorPaymentPlan.execute({
      caseId,
      terms: termsInputOf(request.terms),
    });
    return presentSimulation(simulation);
  }

  async proposeDebtorPaymentPlan(
    request: recoveryV1.ProposeDebtorPaymentPlanRequest,
    metadata?: Metadata,
  ): Promise<recoveryV1.ProposeDebtorPaymentPlanResponse> {
    const { caseId, debtorId } = await this.debtorSession(metadata);
    const plan = await this.useCases.proposeDebtorPaymentPlan.execute({
      caseId,
      debtorId,
      idempotencyKey: request.idempotencyKey,
      terms: termsInputOf(request.terms),
      message: request.message,
    });
    return { plan: presentPlan(plan) };
  }

  async resendDebtorPlanSignature(
    request: recoveryV1.ResendDebtorPlanSignatureRequest,
    metadata?: Metadata,
  ): Promise<recoveryV1.ResendDebtorPlanSignatureResponse> {
    const { caseId, debtorId } = await this.debtorSession(metadata);
    const result = await this.useCases.resendDebtorPlanSignature.execute({
      caseId,
      debtorId,
      planId: request.planId,
    });
    return { signatureExpiresAt: result.signatureExpiresAt.toISOString() };
  }

  async disputeDebtorCase(
    request: recoveryV1.DisputeDebtorCaseRequest,
    metadata?: Metadata,
  ): Promise<recoveryV1.DisputeDebtorCaseResponse> {
    const { caseId, debtorId } = await this.debtorSession(metadata);
    const dispute = await this.useCases.disputeDebtorCase.execute({
      caseId,
      debtorId,
      idempotencyKey: request.idempotencyKey,
      reason: request.reason,
      text: request.text,
      fileIds: request.fileIds,
    });
    return { dispute: presentDispute(dispute) };
  }

  async createDebtorUpload(
    request: recoveryV1.CreateDebtorUploadRequest,
    metadata?: Metadata,
  ): Promise<recoveryV1.CreateDebtorUploadResponse> {
    const { caseId, debtorId } = await this.debtorSession(metadata);
    const slot = await this.useCases.createDebtorUpload.execute({
      caseId,
      debtorId,
      fileName: request.fileName,
      contentType: request.contentType,
      sizeBytes: request.sizeBytes,
    });
    return {
      fileId: slot.fileId,
      uploadUrl: slot.url,
      uploadExpiresAt: slot.expiresAt,
      uploadHeaders: slot.headers,
    };
  }

  async completeDebtorUpload(
    request: recoveryV1.CompleteDebtorUploadRequest,
    metadata?: Metadata,
  ): Promise<recoveryV1.CompleteDebtorUploadResponse> {
    const { caseId, debtorId } = await this.debtorSession(metadata);
    return this.useCases.completeDebtorUpload.execute({ caseId, debtorId, fileId: request.fileId });
  }

  async requestDebtorCallback(
    request: recoveryV1.RequestDebtorCallbackRequest,
    metadata?: Metadata,
  ): Promise<recoveryV1.RequestDebtorCallbackResponse> {
    const { caseId, debtorId } = await this.debtorSession(metadata);
    const result = await this.useCases.requestDebtorCallback.execute({
      caseId,
      debtorId,
      preferredFrom: request.preferredFrom,
      preferredTo: request.preferredTo,
      message: request.message,
    });
    return { requestedAt: result.requestedAt.toISOString() };
  }

  async getDebtorDocumentUrl(
    request: recoveryV1.GetDebtorDocumentUrlRequest,
    metadata?: Metadata,
  ): Promise<recoveryV1.GetDebtorDocumentUrlResponse> {
    const { caseId, debtorId } = await this.debtorSession(metadata);
    return this.useCases.getDebtorDocumentUrl.execute({ caseId, debtorId, documentId: request.documentId });
  }

  /**
   * Dossier et débiteur de la session (`{ caseId, debtorId }`), ou `RECOVERY_DEBTOR_SESSION_INVALID`
   * (401) : session absente, inconnue, expirée ou révoquée.
   */
  private debtorSession(metadata: Metadata | undefined): Promise<DebtorSessionScope> {
    return this.useCases.resolveDebtorSession.execute({ sessionToken: debtorSessionToken(metadata) });
  }
}

@Controller()
@recoveryV1.RecoveryPartnerServiceControllerMethods()
export class RecoveryPartnerGrpcController implements recoveryV1.RecoveryPartnerServiceController {
  listMyAssignments(): Promise<recoveryV1.ListMyAssignmentsResponse> {
    return notImplemented('ListMyAssignments');
  }

  getMyAssignment(): Promise<recoveryV1.GetMyAssignmentResponse> {
    return notImplemented('GetMyAssignment');
  }

  recordLegalAct(): Promise<recoveryV1.RecordLegalActResponse> {
    return notImplemented('RecordLegalAct');
  }

  declarePartnerCollection(): Promise<recoveryV1.DeclarePartnerCollectionResponse> {
    return notImplemented('DeclarePartnerCollection');
  }
}

@Controller()
@recoveryV1.RecoveryAdminServiceControllerMethods()
export class RecoveryAdminGrpcController implements recoveryV1.RecoveryAdminServiceController {
  constructor(@Inject(RECOVERY_USE_CASES) private readonly useCases: RecoveryUseCases) {}

  // Dossiers (R2) : tableau de bord, liste, fiche, journal, recevabilité, affectation.

  async getRecoveryOverview(
    request: recoveryV1.GetRecoveryOverviewRequest,
  ): Promise<recoveryV1.GetRecoveryOverviewResponse> {
    return presentOverview(await this.useCases.getRecoveryOverview.execute(request));
  }

  async getMyWorkQueue(
    request: recoveryV1.GetMyWorkQueueRequest,
  ): Promise<recoveryV1.GetMyWorkQueueResponse> {
    const items = await this.useCases.getMyWorkQueue.execute({ day: request.day });
    return { items: items.map(presentWorkItem) };
  }

  async listCases(request: recoveryV1.ListCasesRequest): Promise<recoveryV1.ListCasesResponse> {
    const filter = request.filter;
    const result = await this.useCases.listCases.execute({
      statuses: filter?.statuses ?? [],
      stages: filter?.stages ?? [],
      kinds: filter?.kinds ?? [],
      assignedAgentId: filter?.assignedAgentId ?? '',
      creditorId: filter?.creditorId ?? '',
      partnerId: filter?.partnerId ?? '',
      communeKey: filter?.communeKey ?? '',
      search: filter?.search ?? '',
      idleDays: filter?.idleDays ?? 0,
      prescriptionNear: filter?.prescriptionNear ?? false,
      ...(request.page ? { page: request.page } : {}),
    });
    return {
      cases: result.items.map(presentSummary),
      nextCursor: result.nextCursor ?? '',
      total: result.total,
    };
  }

  async getCase(request: recoveryV1.GetCaseRequest): Promise<recoveryV1.GetCaseResponse> {
    const result = await this.useCases.getCase.execute(request);
    return {
      case: presentMoneyCase(await this.useCases.addCaseMoney.execute(result.view)),
      scoreFactors: presentScoreFactors(result.score),
      injunctionEligible: result.injunctionEligible,
    };
  }

  async listCaseJournal(
    request: recoveryV1.ListCaseJournalRequest,
  ): Promise<recoveryV1.ListCaseJournalResponse> {
    const view = await this.useCases.listCaseJournal.execute({
      caseId: request.caseId,
      includeInternal: request.includeInternal,
      ...(request.page ? { page: request.page } : {}),
    });
    return { entries: presentJournal(view), nextCursor: view.nextCursor ?? '' };
  }

  async assessCase(request: recoveryV1.AssessCaseRequest): Promise<recoveryV1.AssessCaseResponse> {
    return { case: presentCase(await this.useCases.assessCase.execute(request)) };
  }

  async assignCase(request: recoveryV1.AssignCaseRequest): Promise<recoveryV1.AssignCaseResponse> {
    return { case: presentCase(await this.useCases.assignCase.execute(request)) };
  }

  // Procédure amiable (R4) : contacts, promesses, notes, messages, échéanciers, remises, étapes.

  async recordContact(request: recoveryV1.RecordContactRequest): Promise<recoveryV1.RecordContactResponse> {
    return { entry: presentJournal(await this.useCases.recordContact.execute(request))[0] };
  }

  async recordPromise(request: recoveryV1.RecordPromiseRequest): Promise<recoveryV1.RecordPromiseResponse> {
    const promise = await this.useCases.recordPromise.execute({
      caseId: request.caseId,
      idempotencyKey: request.idempotencyKey,
      amount: amountOf('amount', request.amount),
      dueDate: request.dueDate,
      note: request.note,
    });
    return { promise: presentPromise(promise) };
  }

  async addInternalNote(
    request: recoveryV1.AddInternalNoteRequest,
  ): Promise<recoveryV1.AddInternalNoteResponse> {
    return { entry: presentJournal(await this.useCases.addInternalNote.execute(request))[0] };
  }

  async sendDebtorMessage(
    request: recoveryV1.SendDebtorMessageRequest,
  ): Promise<recoveryV1.SendDebtorMessageResponse> {
    return { entry: presentJournal(await this.useCases.sendDebtorMessage.execute(request))[0] };
  }

  async proposePaymentPlan(
    request: recoveryV1.ProposePaymentPlanRequest,
  ): Promise<recoveryV1.ProposePaymentPlanResponse> {
    const plan = await this.useCases.proposePaymentPlan.execute({
      caseId: request.caseId,
      idempotencyKey: request.idempotencyKey,
      terms: termsInputOf(request.terms),
      note: request.note,
    });
    return { plan: presentPlan(plan) };
  }

  async approvePaymentPlan(
    request: recoveryV1.ApprovePaymentPlanRequest,
  ): Promise<recoveryV1.ApprovePaymentPlanResponse> {
    return { plan: presentPlan(await this.useCases.approvePaymentPlan.execute(request)) };
  }

  async proposeSettlement(
    request: recoveryV1.ProposeSettlementRequest,
  ): Promise<recoveryV1.ProposeSettlementResponse> {
    const settlement = await this.useCases.proposeSettlement.execute({
      caseId: request.caseId,
      idempotencyKey: request.idempotencyKey,
      payNow: amountOf('payNow', request.payNow),
      validUntil: request.validUntil,
      note: request.note,
    });
    return { settlement: presentSettlement(settlement) };
  }

  async changeCaseStage(
    request: recoveryV1.ChangeCaseStageRequest,
  ): Promise<recoveryV1.ChangeCaseStageResponse> {
    return { case: presentCase(await this.useCases.changeCaseStage.execute(request)) };
  }

  issueFormalNotice(): Promise<recoveryV1.IssueFormalNoticeResponse> {
    return notImplemented('IssueFormalNotice');
  }

  recordNoticeDelivery(): Promise<recoveryV1.RecordNoticeDeliveryResponse> {
    return notImplemented('RecordNoticeDelivery');
  }

  async resolveDispute(
    request: recoveryV1.ResolveDisputeRequest,
  ): Promise<recoveryV1.ResolveDisputeResponse> {
    const view = await this.useCases.resolveDispute.execute({
      caseId: request.caseId,
      disputeId: request.disputeId,
      resolution: request.resolution,
      correctedDue: amountOf('correctedDue', request.correctedDue),
      note: request.note,
    });
    return { case: presentMoneyCase(view) };
  }

  requestEscalation(): Promise<recoveryV1.RequestEscalationResponse> {
    return notImplemented('RequestEscalation');
  }

  suggestPartners(): Promise<recoveryV1.SuggestPartnersResponse> {
    return notImplemented('SuggestPartners');
  }

  assignPartner(): Promise<recoveryV1.AssignPartnerResponse> {
    return notImplemented('AssignPartner');
  }

  withdrawPartner(): Promise<recoveryV1.WithdrawPartnerResponse> {
    return notImplemented('WithdrawPartner');
  }

  // Argent (R3) : paiements hors ligne validés à deux, trop-perçus remboursés.

  async recordOfflinePayment(
    request: recoveryV1.RecordOfflinePaymentRequest,
  ): Promise<recoveryV1.RecordOfflinePaymentResponse> {
    const view = await this.useCases.recordOfflinePayment.execute({
      caseId: request.caseId,
      idempotencyKey: request.idempotencyKey,
      source: request.source,
      amount: amountOf('amount', request.amount),
      receivedOn: request.receivedOn,
      reference: request.reference,
      proofFileId: request.proofFileId,
    });
    return { payment: presentOfflinePayment(view) };
  }

  async listOfflinePayments(
    request: recoveryV1.ListOfflinePaymentsRequest,
  ): Promise<recoveryV1.ListOfflinePaymentsResponse> {
    const result = await this.useCases.listOfflinePayments.execute({
      statuses: request.statuses,
      caseId: request.caseId,
      ...(request.page ? { page: request.page } : {}),
    });
    return { payments: result.items.map(presentOfflinePayment), nextCursor: result.nextCursor ?? '' };
  }

  async approveOfflinePayment(
    request: recoveryV1.ApproveOfflinePaymentRequest,
  ): Promise<recoveryV1.ApproveOfflinePaymentResponse> {
    const result = await this.useCases.approveOfflinePayment.execute({
      offlinePaymentId: request.offlinePaymentId,
    });
    return {
      payment: presentOfflinePayment(result.payment),
      collection: presentCollection(result.collection),
    };
  }

  async rejectOfflinePayment(
    request: recoveryV1.RejectOfflinePaymentRequest,
  ): Promise<recoveryV1.RejectOfflinePaymentResponse> {
    const view = await this.useCases.rejectOfflinePayment.execute({
      offlinePaymentId: request.offlinePaymentId,
      reason: request.reason,
    });
    return { payment: presentOfflinePayment(view) };
  }

  async recordOverpaymentRefund(
    request: recoveryV1.RecordOverpaymentRefundRequest,
  ): Promise<recoveryV1.RecordOverpaymentRefundResponse> {
    const view = await this.useCases.recordOverpaymentRefund.execute({
      caseId: request.caseId,
      idempotencyKey: request.idempotencyKey,
      amount: amountOf('amount', request.amount),
      reference: request.reference,
      note: request.note,
    });
    return { case: presentMoneyCase(view) };
  }

  closeCase(): Promise<recoveryV1.CloseCaseResponse> {
    return notImplemented('CloseCase');
  }

  exportCaseJournal(): Promise<recoveryV1.ExportCaseJournalResponse> {
    return notImplemented('ExportCaseJournal');
  }

  listPartners(): Promise<recoveryV1.ListPartnersResponse> {
    return notImplemented('ListPartners');
  }

  getPartner(): Promise<recoveryV1.GetPartnerResponse> {
    return notImplemented('GetPartner');
  }

  createPartner(): Promise<recoveryV1.CreatePartnerResponse> {
    return notImplemented('CreatePartner');
  }

  updatePartner(): Promise<recoveryV1.UpdatePartnerResponse> {
    return notImplemented('UpdatePartner');
  }

  async listPricingRules(
    request: recoveryV1.ListPricingRulesRequest,
  ): Promise<recoveryV1.ListPricingRulesResponse> {
    const result = await this.useCases.listPricingRules.execute({
      object: request.object,
      statuses: request.statuses,
      offer: request.offer,
      creditorId: request.creditorId,
      ...(request.page ? { page: request.page } : {}),
    });
    return { rules: result.items.map(presentPricingRule), nextCursor: result.nextCursor ?? '' };
  }

  async getPricingRule(
    request: recoveryV1.GetPricingRuleRequest,
  ): Promise<recoveryV1.GetPricingRuleResponse> {
    return {
      rule: presentPricingRule(await this.useCases.getPricingRule.execute({ ruleId: request.ruleId })),
    };
  }

  async createPricingRule(
    request: recoveryV1.CreatePricingRuleRequest,
  ): Promise<recoveryV1.CreatePricingRuleResponse> {
    const rule = await this.useCases.createPricingRule.execute({
      idempotencyKey: request.idempotencyKey,
      input: pricingInputOf(request.input),
    });
    return { rule: presentPricingRule(rule) };
  }

  async updatePricingRule(
    request: recoveryV1.UpdatePricingRuleRequest,
  ): Promise<recoveryV1.UpdatePricingRuleResponse> {
    const rule = await this.useCases.updatePricingRule.execute({
      ruleId: request.ruleId,
      input: pricingInputOf(request.input),
    });
    return { rule: presentPricingRule(rule) };
  }

  async publishPricingRule(
    request: recoveryV1.PublishPricingRuleRequest,
  ): Promise<recoveryV1.PublishPricingRuleResponse> {
    return {
      rule: presentPricingRule(await this.useCases.publishPricingRule.execute({ ruleId: request.ruleId })),
    };
  }

  async approvePricingRule(
    request: recoveryV1.ApprovePricingRuleRequest,
  ): Promise<recoveryV1.ApprovePricingRuleResponse> {
    return {
      rule: presentPricingRule(await this.useCases.approvePricingRule.execute({ ruleId: request.ruleId })),
    };
  }

  async archivePricingRule(
    request: recoveryV1.ArchivePricingRuleRequest,
  ): Promise<recoveryV1.ArchivePricingRuleResponse> {
    const rule = await this.useCases.archivePricingRule.execute({
      ruleId: request.ruleId,
      reason: request.reason,
    });
    return { rule: presentPricingRule(rule) };
  }

  async simulatePricing(
    request: recoveryV1.SimulatePricingRequest,
  ): Promise<recoveryV1.SimulatePricingResponse> {
    const result = await this.useCases.simulatePricing.execute({
      ruleId: request.ruleId,
      object: request.object,
      offer: request.target?.offer ?? '',
      communeKey: request.target?.communeKey || null,
      creditorId: request.target?.creditor?.id || null,
      baseAmount: amountOf('baseAmount', request.baseAmount) ?? 0,
      stage: request.stage,
    });
    return presentPricingResult(result);
  }

  async getRecoverySettings(): Promise<recoveryV1.GetRecoverySettingsResponse> {
    return { settings: presentSettings(await this.useCases.getSettings.execute()) };
  }

  async updateRecoverySettings(
    request: recoveryV1.UpdateRecoverySettingsRequest,
  ): Promise<recoveryV1.UpdateRecoverySettingsResponse> {
    const stored = await this.useCases.updateSettings.execute({ settings: settingsOf(request.settings) });
    return { settings: presentSettings(stored) };
  }

  async listHolidays(request: recoveryV1.ListHolidaysRequest): Promise<recoveryV1.ListHolidaysResponse> {
    return { holidays: await this.useCases.listHolidays.execute({ year: request.year }) };
  }

  async setHolidays(request: recoveryV1.SetHolidaysRequest): Promise<recoveryV1.SetHolidaysResponse> {
    return {
      holidays: await this.useCases.setHolidays.execute({ year: request.year, holidays: request.holidays }),
    };
  }
}
