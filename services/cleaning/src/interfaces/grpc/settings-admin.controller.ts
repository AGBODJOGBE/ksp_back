import { cleaningV1 } from '@ksp/contracts';
import { Controller, Inject, Logger } from '@nestjs/common';
import { CLEANING_DEPS, type CleaningDeps } from '../../application/deps';
import { type SettingsView, SettingsUseCases } from '../../application/settings/settings.use-cases';
import { type ModuleSettings } from '../../domain/settings/settings';
import { money } from './catalog.presenters';

/**
 * Adaptateur gRPC de SettingsAdminService — back-office : réglages du module (UC-NT-43, lot G).
 */
@Controller()
@cleaningV1.SettingsAdminServiceControllerMethods()
export class SettingsAdminGrpcController implements cleaningV1.SettingsAdminServiceController {
  private readonly logger = new Logger(SettingsAdminGrpcController.name);
  private readonly settings: SettingsUseCases;

  constructor(@Inject(CLEANING_DEPS) deps: CleaningDeps) {
    // Piste O : une organisation dont la réévaluation échoue après un changement des seuils le
    // sera à son prochain événement de facture ; l'échec est journalisé.
    this.settings = new SettingsUseCases(deps, (organizationId, error) =>
      this.logger.error(
        `Seuils d'impayés : réévaluation de l'organisation ${organizationId} en échec : ` +
          (error instanceof Error ? error.message : String(error)),
      ),
    );
  }

  async getSettings(): Promise<cleaningV1.GetSettingsResponse> {
    return { settings: toSettings(await this.settings.get()) };
  }

  async updateSettings(
    request: cleaningV1.UpdateSettingsRequest,
  ): Promise<cleaningV1.UpdateSettingsResponse> {
    return { settings: toSettings(await this.settings.update(toPatch(request))) };
  }
}

/** Réglages → message du contrat ; frais de visite rendus seulement avec cleaning.amounts.read. */
export function toSettings(view: SettingsView): cleaningV1.Settings {
  const s = view.settings;
  return {
    maxOpenRequestsPerAccount: s.maxOpenRequests,
    minVisitLeadHours: s.minVisitLeadHours,
    visitFeePaymentHours: s.visitFeePaymentHours,
    visitTargetBusinessHours: s.visitTargetHours,
    visitDurationMinutes: s.visitDurationMinutes,
    defaultTravelMinutes: s.defaultTravelMinutes,
    ...(view.showAmounts ? { defaultVisitFee: money(s.defaultVisitFee) } : {}),
    deductVisitFee: s.deductVisitFee,
    quoteValidityDays: s.quoteValidityDays,
    quoteReminderDays: s.quoteReminderDays,
    maxDiscountWithoutApprovalPercent: s.maxDiscountWithoutApprovalPct,
    firstSessionLeadHours: s.firstSessionLeadHours,
    programMaxMonths: s.programMaxMonths,
    programMaxSessions: s.programMaxSessions,
    freeCancellationHours: s.freeCancellationHours,
    reschedulesPerMonth: s.maxReschedulesPerMonth,
    lateCancellationFeePercent: s.lateCancellationFeePct,
    sessionPaymentGraceHours: s.sessionPaymentGraceHours,
    overdueSessionsBeforeSuspension: s.overdueSessionsBeforeSuspension,
    balanceGuarantee: s.balanceGuarantee,
    unpaidInvoicesWarning: s.unpaidInvoicesWarning,
    unpaidInvoicesSuspension: s.unpaidInvoicesSuspension,
    defaultPlanningMode: s.defaultPlanningMode,
    planningHorizonDays: s.planningHorizonDays,
    scoreWeights: { ...s.scoreWeights },
    assignmentResponseHours: s.assignmentResponseHours,
    defaultMaxHoursPerDay: s.defaultMaxHoursDay,
    defaultMaxHoursPerWeek: s.defaultMaxHoursWeek,
    maxPhotosPerKind: s.maxPhotosPerType,
    claimWindowHours: s.claimWindowHours,
    retentionMonths: s.retentionMonths,
    commonChecklist: s.commonChecklist.map((point) => ({ ...point })),
    arrivalAlertMeters: s.arrivalAlertMeters,
    arrivalMaxAdvanceMinutes: s.arrivalMaxAdvanceMinutes,
    customerWaitMinutes: s.customerWaitMinutes,
    updatedAt: (view.updatedAt ?? new Date(0)).toISOString(),
    ...(view.updatedBy ? { updatedBy: view.updatedBy } : {}),
    ...(view.updatedByName ? { updatedByName: view.updatedByName } : {}),
  };
}

/** PATCH du contrat → réglages fournis ; un champ absent reste inchangé. */
export function toPatch(request: cleaningV1.UpdateSettingsRequest): Partial<ModuleSettings> {
  const patch: Partial<ModuleSettings> = {
    maxOpenRequests: request.maxOpenRequestsPerAccount,
    minVisitLeadHours: request.minVisitLeadHours,
    visitFeePaymentHours: request.visitFeePaymentHours,
    visitTargetHours: request.visitTargetBusinessHours,
    visitDurationMinutes: request.visitDurationMinutes,
    defaultTravelMinutes: request.defaultTravelMinutes,
    defaultVisitFee: request.defaultVisitFee?.amount,
    deductVisitFee: request.deductVisitFee,
    quoteValidityDays: request.quoteValidityDays,
    quoteReminderDays: request.quoteReminderDays,
    maxDiscountWithoutApprovalPct: request.maxDiscountWithoutApprovalPercent,
    firstSessionLeadHours: request.firstSessionLeadHours,
    programMaxMonths: request.programMaxMonths,
    programMaxSessions: request.programMaxSessions,
    freeCancellationHours: request.freeCancellationHours,
    maxReschedulesPerMonth: request.reschedulesPerMonth,
    lateCancellationFeePct: request.lateCancellationFeePercent,
    sessionPaymentGraceHours: request.sessionPaymentGraceHours,
    overdueSessionsBeforeSuspension: request.overdueSessionsBeforeSuspension,
    balanceGuarantee: request.balanceGuarantee,
    unpaidInvoicesWarning: request.unpaidInvoicesWarning,
    unpaidInvoicesSuspension: request.unpaidInvoicesSuspension,
    defaultPlanningMode: request.defaultPlanningMode as ModuleSettings['defaultPlanningMode'] | undefined,
    planningHorizonDays: request.planningHorizonDays,
    scoreWeights: request.scoreWeights ? { ...request.scoreWeights } : undefined,
    assignmentResponseHours: request.assignmentResponseHours,
    defaultMaxHoursDay: request.defaultMaxHoursPerDay,
    defaultMaxHoursWeek: request.defaultMaxHoursPerWeek,
    maxPhotosPerType: request.maxPhotosPerKind,
    claimWindowHours: request.claimWindowHours,
    retentionMonths: request.retentionMonths,
    commonChecklist: request.commonChecklist?.items.map((item) => ({ ...item })),
    arrivalAlertMeters: request.arrivalAlertMeters,
    arrivalMaxAdvanceMinutes: request.arrivalMaxAdvanceMinutes,
    customerWaitMinutes: request.customerWaitMinutes,
  };
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<ModuleSettings>;
}
