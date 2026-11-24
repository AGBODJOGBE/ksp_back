import { alignPrograms, type OrganizationProgram, type ProgramChange } from './alignment';
import {
  decideOrganizationStanding,
  type OrganizationBillingStanding,
  type UnpaidThresholds,
  unpaidWarningPayload,
  withDecision,
} from './standing';

/**
 * Réaction de cleaning au compte d'impayés d'une organisation (lot F, UC-NT-47) : décision
 * (R-PE-06), changements des programmes (R-SU-01 à R-SU-03) et avertissement (RV-83), à écrire dans
 * une seule transaction, sous le verrou de l'organisation. Appelée après une facture passée
 * impayée ou soldée (`billing.invoice.overdue` / `.paid`), après un changement des seuils, et à la
 * reprise d'un programme de l'organisation pour une autre cause (réévaluation).
 */
export function reactToUnpaidCount(input: {
  standing: OrganizationBillingStanding;
  overdueInvoiceIds: readonly string[];
  thresholds: UnpaidThresholds;
  programs: readonly OrganizationProgram[];
  now: Date;
  resume: Parameters<typeof alignPrograms>[0]['resume'];
}): {
  standing: OrganizationBillingStanding;
  changes: ProgramChange[];
  warning: ReturnType<typeof unpaidWarningPayload> | null;
} {
  const overdueCount = input.overdueInvoiceIds.length;
  const decision = decideOrganizationStanding({
    overdueCount,
    warningLevel: input.standing.warningLevel,
    thresholds: input.thresholds,
    programs: input.programs,
  });
  const changes = alignPrograms({
    programs: input.programs,
    decision,
    now: input.now,
    resume: input.resume,
  });
  return {
    standing: withDecision(input.standing, overdueCount, decision),
    changes,
    warning: decision.warn
      ? unpaidWarningPayload({
          organizationId: input.standing.organizationId,
          overdueCount,
          thresholds: input.thresholds,
          overdueInvoiceIds: input.overdueInvoiceIds,
          now: input.now,
        })
      : null,
  };
}
