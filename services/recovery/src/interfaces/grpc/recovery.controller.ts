import { recoveryV1 } from '@ksp/contracts';
import { Controller, Inject } from '@nestjs/common';
import { RECOVERY_USE_CASES, type RecoveryUseCases } from '../../application/use-cases';
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
// tarification, les réglages, les jours fériés et l'estimation des frais ; les autres méthodes
// répondent « pas encore disponible » jusqu'à leur branche (R2 à R5).

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

  createCase(): Promise<recoveryV1.CreateCaseResponse> {
    return notImplemented('CreateCase');
  }

  updateCase(): Promise<recoveryV1.UpdateCaseResponse> {
    return notImplemented('UpdateCase');
  }

  addCaseDocument(): Promise<recoveryV1.AddCaseDocumentResponse> {
    return notImplemented('AddCaseDocument');
  }

  prepareMandate(): Promise<recoveryV1.PrepareMandateResponse> {
    return notImplemented('PrepareMandate');
  }

  payCaseFee(): Promise<recoveryV1.PayCaseFeeResponse> {
    return notImplemented('PayCaseFee');
  }

  listMyCases(): Promise<recoveryV1.ListMyCasesResponse> {
    return notImplemented('ListMyCases');
  }

  getMyCase(): Promise<recoveryV1.GetMyCaseResponse> {
    return notImplemented('GetMyCase');
  }

  listMyCaseJournal(): Promise<recoveryV1.ListMyCaseJournalResponse> {
    return notImplemented('ListMyCaseJournal');
  }

  createCaseImport(): Promise<recoveryV1.CreateCaseImportResponse> {
    return notImplemented('CreateCaseImport');
  }

  getCaseImport(): Promise<recoveryV1.GetCaseImportResponse> {
    return notImplemented('GetCaseImport');
  }

  updateCaseImportLine(): Promise<recoveryV1.UpdateCaseImportLineResponse> {
    return notImplemented('UpdateCaseImportLine');
  }

  confirmCaseImport(): Promise<recoveryV1.ConfirmCaseImportResponse> {
    return notImplemented('ConfirmCaseImport');
  }

  listMyDecisions(): Promise<recoveryV1.ListMyDecisionsResponse> {
    return notImplemented('ListMyDecisions');
  }

  answerDecision(): Promise<recoveryV1.AnswerDecisionResponse> {
    return notImplemented('AnswerDecision');
  }

  stopCase(): Promise<recoveryV1.StopCaseResponse> {
    return notImplemented('StopCase');
  }

  declareDirectPayment(): Promise<recoveryV1.DeclareDirectPaymentResponse> {
    return notImplemented('DeclareDirectPayment');
  }

  listMyRemittances(): Promise<recoveryV1.ListMyRemittancesResponse> {
    return notImplemented('ListMyRemittances');
  }

  listMyStatements(): Promise<recoveryV1.ListMyStatementsResponse> {
    return notImplemented('ListMyStatements');
  }

  getMyDashboard(): Promise<recoveryV1.GetMyDashboardResponse> {
    return notImplemented('GetMyDashboard');
  }

  getMyPreferences(): Promise<recoveryV1.GetMyPreferencesResponse> {
    return notImplemented('GetMyPreferences');
  }

  updateMyPreferences(): Promise<recoveryV1.UpdateMyPreferencesResponse> {
    return notImplemented('UpdateMyPreferences');
  }
}

@Controller()
@recoveryV1.RecoveryDebtorServiceControllerMethods()
export class RecoveryDebtorGrpcController implements recoveryV1.RecoveryDebtorServiceController {
  openDebtorAccess(): Promise<recoveryV1.OpenDebtorAccessResponse> {
    return notImplemented('OpenDebtorAccess');
  }

  sendDebtorAccessCode(): Promise<recoveryV1.SendDebtorAccessCodeResponse> {
    return notImplemented('SendDebtorAccessCode');
  }

  verifyDebtorAccessCode(): Promise<recoveryV1.VerifyDebtorAccessCodeResponse> {
    return notImplemented('VerifyDebtorAccessCode');
  }

  endDebtorSession(): Promise<recoveryV1.EndDebtorSessionResponse> {
    return notImplemented('EndDebtorSession');
  }

  getDebtorCase(): Promise<recoveryV1.GetDebtorCaseResponse> {
    return notImplemented('GetDebtorCase');
  }

  createDebtorPayment(): Promise<recoveryV1.CreateDebtorPaymentResponse> {
    return notImplemented('CreateDebtorPayment');
  }

  simulateDebtorPaymentPlan(): Promise<recoveryV1.SimulateDebtorPaymentPlanResponse> {
    return notImplemented('SimulateDebtorPaymentPlan');
  }

  proposeDebtorPaymentPlan(): Promise<recoveryV1.ProposeDebtorPaymentPlanResponse> {
    return notImplemented('ProposeDebtorPaymentPlan');
  }

  resendDebtorPlanSignature(): Promise<recoveryV1.ResendDebtorPlanSignatureResponse> {
    return notImplemented('ResendDebtorPlanSignature');
  }

  disputeDebtorCase(): Promise<recoveryV1.DisputeDebtorCaseResponse> {
    return notImplemented('DisputeDebtorCase');
  }

  createDebtorUpload(): Promise<recoveryV1.CreateDebtorUploadResponse> {
    return notImplemented('CreateDebtorUpload');
  }

  completeDebtorUpload(): Promise<recoveryV1.CompleteDebtorUploadResponse> {
    return notImplemented('CompleteDebtorUpload');
  }

  requestDebtorCallback(): Promise<recoveryV1.RequestDebtorCallbackResponse> {
    return notImplemented('RequestDebtorCallback');
  }

  getDebtorDocumentUrl(): Promise<recoveryV1.GetDebtorDocumentUrlResponse> {
    return notImplemented('GetDebtorDocumentUrl');
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

  getRecoveryOverview(): Promise<recoveryV1.GetRecoveryOverviewResponse> {
    return notImplemented('GetRecoveryOverview');
  }

  getMyWorkQueue(): Promise<recoveryV1.GetMyWorkQueueResponse> {
    return notImplemented('GetMyWorkQueue');
  }

  listCases(): Promise<recoveryV1.ListCasesResponse> {
    return notImplemented('ListCases');
  }

  getCase(): Promise<recoveryV1.GetCaseResponse> {
    return notImplemented('GetCase');
  }

  listCaseJournal(): Promise<recoveryV1.ListCaseJournalResponse> {
    return notImplemented('ListCaseJournal');
  }

  assessCase(): Promise<recoveryV1.AssessCaseResponse> {
    return notImplemented('AssessCase');
  }

  assignCase(): Promise<recoveryV1.AssignCaseResponse> {
    return notImplemented('AssignCase');
  }

  recordContact(): Promise<recoveryV1.RecordContactResponse> {
    return notImplemented('RecordContact');
  }

  recordPromise(): Promise<recoveryV1.RecordPromiseResponse> {
    return notImplemented('RecordPromise');
  }

  addInternalNote(): Promise<recoveryV1.AddInternalNoteResponse> {
    return notImplemented('AddInternalNote');
  }

  sendDebtorMessage(): Promise<recoveryV1.SendDebtorMessageResponse> {
    return notImplemented('SendDebtorMessage');
  }

  proposePaymentPlan(): Promise<recoveryV1.ProposePaymentPlanResponse> {
    return notImplemented('ProposePaymentPlan');
  }

  approvePaymentPlan(): Promise<recoveryV1.ApprovePaymentPlanResponse> {
    return notImplemented('ApprovePaymentPlan');
  }

  proposeSettlement(): Promise<recoveryV1.ProposeSettlementResponse> {
    return notImplemented('ProposeSettlement');
  }

  changeCaseStage(): Promise<recoveryV1.ChangeCaseStageResponse> {
    return notImplemented('ChangeCaseStage');
  }

  issueFormalNotice(): Promise<recoveryV1.IssueFormalNoticeResponse> {
    return notImplemented('IssueFormalNotice');
  }

  recordNoticeDelivery(): Promise<recoveryV1.RecordNoticeDeliveryResponse> {
    return notImplemented('RecordNoticeDelivery');
  }

  resolveDispute(): Promise<recoveryV1.ResolveDisputeResponse> {
    return notImplemented('ResolveDispute');
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

  recordOfflinePayment(): Promise<recoveryV1.RecordOfflinePaymentResponse> {
    return notImplemented('RecordOfflinePayment');
  }

  listOfflinePayments(): Promise<recoveryV1.ListOfflinePaymentsResponse> {
    return notImplemented('ListOfflinePayments');
  }

  approveOfflinePayment(): Promise<recoveryV1.ApproveOfflinePaymentResponse> {
    return notImplemented('ApproveOfflinePayment');
  }

  rejectOfflinePayment(): Promise<recoveryV1.RejectOfflinePaymentResponse> {
    return notImplemented('RejectOfflinePayment');
  }

  recordOverpaymentRefund(): Promise<recoveryV1.RecordOverpaymentRefundResponse> {
    return notImplemented('RecordOverpaymentRefund');
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
