import { type CaseSettings, type CaseSettingsReader } from '../../../application/requests/requests.ports';
import { type PrismaService } from '../../prisma/prisma.service';

/** Réglages du dossier (partie 16.1) : ligne unique (id = 1), valeurs par défaut du schéma sinon. */
export class PrismaCaseSettingsReader implements CaseSettingsReader {
  constructor(private readonly prisma: PrismaService) {}

  async caseSettings(): Promise<CaseSettings> {
    const row =
      (await this.prisma.cleaningSettings.findUnique({ where: { id: 1 } })) ??
      (await this.prisma.cleaningSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} }));
    return {
      maxOpenRequests: row.maxOpenRequests,
      minVisitLeadHours: row.minVisitLeadHours,
      visitFeePaymentHours: row.visitFeePaymentHours,
      visitDurationMinutes: row.visitDurationMinutes,
      defaultVisitFee: row.defaultVisitFee,
      deductVisitFee: row.deductVisitFee,
      quoteValidityDays: row.quoteValidityDays,
      quoteReminderDays: row.quoteReminderDays,
      maxDiscountWithoutApprovalPct: row.maxDiscountWithoutApprovalPct,
      firstSessionLeadHours: row.firstSessionLeadHours,
      freeCancellationHours: row.freeCancellationHours,
      maxPhotosPerType: row.maxPhotosPerType,
      arrivalAlertMeters: row.arrivalAlertMeters,
      unpaidInvoicesSuspension: row.unpaidInvoicesSuspension,
    };
  }
}
