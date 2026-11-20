import { ConcurrentUpdateError } from '../../../application/agents/agent.ports';
import { type Changes, type IdGenerator } from '../../../application/ports';
import {
  type SettingsRepository,
  type StoredSettings,
} from '../../../application/settings/settings.use-cases';
import { type ChecklistPoint, type ModuleSettings } from '../../../domain/settings/settings';
import { type PrismaService } from '../../prisma/prisma.service';
import { json, writeChanges } from '../changes';

/**
 * Réglages du module (ligne unique cleaning_settings, id = 1). La modification est conditionnée par
 * la version et écrite dans la même transaction que sa trace d'audit.
 */
export class PrismaSettingsRepository implements SettingsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ids: IdGenerator,
  ) {}

  async read(): Promise<StoredSettings> {
    const row = await this.prisma.cleaningSettings.findUniqueOrThrow({ where: { id: 1 } });
    return {
      settings: {
        maxOpenRequests: row.maxOpenRequests,
        minVisitLeadHours: row.minVisitLeadHours,
        visitFeePaymentHours: row.visitFeePaymentHours,
        visitTargetHours: row.visitTargetHours,
        visitDurationMinutes: row.visitDurationMinutes,
        defaultTravelMinutes: row.defaultTravelMinutes,
        defaultVisitFee: row.defaultVisitFee,
        deductVisitFee: row.deductVisitFee,
        quoteValidityDays: row.quoteValidityDays,
        quoteReminderDays: row.quoteReminderDays,
        maxDiscountWithoutApprovalPct: row.maxDiscountWithoutApprovalPct,
        firstSessionLeadHours: row.firstSessionLeadHours,
        programMaxMonths: row.programMaxMonths,
        programMaxSessions: row.programMaxSessions,
        freeCancellationHours: row.freeCancellationHours,
        maxReschedulesPerMonth: row.maxReschedulesPerMonth,
        lateCancellationFeePct: row.lateCancellationFeePct,
        sessionPaymentGraceHours: row.sessionPaymentGraceHours,
        overdueSessionsBeforeSuspension: row.overdueSessionsBeforeSuspension,
        balanceGuarantee: row.balanceGuarantee,
        unpaidInvoicesWarning: row.unpaidInvoicesWarning,
        unpaidInvoicesSuspension: row.unpaidInvoicesSuspension,
        defaultPlanningMode: row.defaultPlanningMode,
        planningHorizonDays: row.planningHorizonDays,
        scoreWeights: {
          continuity: row.scoreWeightContinuity,
          proximity: row.scoreWeightProximity,
          balance: row.scoreWeightBalance,
          rating: row.scoreWeightRating,
        },
        assignmentResponseHours: row.assignmentResponseHours,
        defaultMaxHoursDay: row.defaultMaxHoursDay,
        defaultMaxHoursWeek: row.defaultMaxHoursWeek,
        maxPhotosPerType: row.maxPhotosPerType,
        claimWindowHours: row.claimWindowHours,
        retentionMonths: row.retentionMonths,
        commonChecklist: (row.commonChecklist as unknown as ChecklistPoint[]).map((point) => ({
          code: point.code,
          label: point.label,
          order: point.order,
        })),
        arrivalAlertMeters: row.arrivalAlertMeters,
        arrivalMaxAdvanceMinutes: row.arrivalMaxAdvanceMinutes,
        customerWaitMinutes: row.customerWaitMinutes,
      },
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
      version: row.version,
    };
  }

  async save(
    settings: ModuleSettings,
    expected: { version: number; by: string; at: Date },
    changes: Changes,
  ): Promise<void> {
    const { scoreWeights, commonChecklist, ...plain } = settings;
    await this.prisma.$transaction(async (tx) => {
      await writeChanges(tx, changes, () => this.ids.next());
      const { count } = await tx.cleaningSettings.updateMany({
        where: { id: 1, version: expected.version },
        data: {
          ...plain,
          scoreWeightContinuity: scoreWeights.continuity,
          scoreWeightProximity: scoreWeights.proximity,
          scoreWeightBalance: scoreWeights.balance,
          scoreWeightRating: scoreWeights.rating,
          commonChecklist: json(commonChecklist),
          updatedBy: expected.by,
          updatedAt: expected.at,
          version: { increment: 1 },
        },
      });
      if (count !== 1) throw new ConcurrentUpdateError();
    });
  }
}
