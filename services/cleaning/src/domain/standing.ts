import { type Mission, type Suspension, type SuspensionCause } from './mission';
import { paidAmount } from './payment';
import { type CleaningSettings } from './settings';

/**
 * Situation de paiement d'une mission (CDC Nettoyage, partie 10).
 * - Entreprise : factures mensuelles (service billing) ; avertissement dès N impayées, suspension
 *   à M impayées, déblocage quand le nombre repasse sous M.
 * - Particulier en récurrent : chaque passage terminé doit être payé ; N passages impayés
 *   suspendent le service jusqu'à régularisation.
 * - Particulier ponctuel : rien à suspendre (tout est dû à la fin de l'unique passage).
 */
export type StandingAction = 'none' | 'warn' | 'suspend' | 'resume';

export interface StandingThresholds {
  /** Seuil d'avertissement, null s'il n'y en a pas (particulier). */
  warnAt: number | null;
  suspendAt: number;
}

const HOUR_MS = 3_600_000;

export function isBusinessContract(mission: Pick<Mission, 'organizationId'>): boolean {
  return mission.organizationId !== null;
}

/** Mission soumise à la règle des impayés : contrat d'entreprise, ou particulier en récurrent. */
export function standingCause(
  mission: Pick<Mission, 'organizationId' | 'recurrence'>,
): SuspensionCause | null {
  if (isBusinessContract(mission)) return 'unpaid_invoices';
  return mission.recurrence ? 'unpaid_interventions' : null;
}

export function thresholdsFor(cause: SuspensionCause, settings: CleaningSettings): StandingThresholds {
  return cause === 'unpaid_invoices'
    ? { warnAt: settings.businessWarningUnpaidInvoices, suspendAt: settings.businessSuspensionUnpaidInvoices }
    : { warnAt: null, suspendAt: settings.individualSuspensionUnpaidInterventions };
}

/**
 * Passages impayés d'un particulier : passages terminés depuis plus du délai de grâce, moins
 * ceux que les paiements reçus couvrent (prix d'un passage = total / passages prévus).
 */
export function unpaidInterventions(
  mission: Pick<Mission, 'interventions' | 'plannedInterventions' | 'payment'>,
  now: Date,
  graceHours: number,
): number {
  const limit = now.getTime() - graceHours * HOUR_MS;
  const due = mission.interventions.filter(
    (intervention) =>
      intervention.status === 'completed' &&
      intervention.completedAt !== null &&
      intervention.completedAt.getTime() <= limit,
  ).length;
  if (due === 0 || mission.payment.total <= 0) return 0;
  const covered = Math.floor(
    (paidAmount(mission.payment) * mission.plannedInterventions) / mission.payment.total,
  );
  return Math.max(0, due - covered);
}

/**
 * Décision à prendre : suspendre au seuil, débloquer sous le seuil, avertir (une seule fois par
 * niveau d'impayés) entre le seuil d'avertissement et celui de suspension.
 */
export function decideStanding(
  state: { suspension: Suspension | null; warningLevel: number },
  unpaid: number,
  thresholds: StandingThresholds,
): StandingAction {
  if (state.suspension) return unpaid < thresholds.suspendAt ? 'resume' : 'none';
  if (unpaid >= thresholds.suspendAt) return 'suspend';
  if (thresholds.warnAt !== null && unpaid >= thresholds.warnAt && unpaid > state.warningLevel) return 'warn';
  return 'none';
}

export interface SuspensionResult {
  mission: Mission;
  cancelledInterventionIds: string[];
  releasedAgentIds: string[];
}

/**
 * Suspend la mission : les passages planifiés sont annulés (cause « suspension ») et leurs
 * agents libérés ; les passages en cours ou en attente d'incident ne sont pas touchés.
 */
export function suspendMission(
  mission: Mission,
  cause: SuspensionCause,
  unpaidCount: number,
  now: Date,
): SuspensionResult {
  const cancelled = mission.interventions.filter((intervention) => intervention.status === 'planned');
  const cancelledIds = new Set(cancelled.map((intervention) => intervention.id));
  return {
    mission: {
      ...mission,
      suspension: { cause, since: now, unpaidCount },
      interventions: mission.interventions.map((intervention) =>
        cancelledIds.has(intervention.id)
          ? { ...intervention, status: 'cancelled', cancellationCause: 'suspension', cancelledAt: now }
          : intervention,
      ),
    },
    cancelledInterventionIds: [...cancelledIds],
    releasedAgentIds: [...new Set(cancelled.flatMap((intervention) => intervention.agentIds))].sort(),
  };
}

/** Passages annulés par la suspension en cours, à reprogrammer au déblocage. */
export function passagesToReschedule(mission: Pick<Mission, 'interventions' | 'suspension'>) {
  const since = mission.suspension?.since;
  if (!since) return [];
  return mission.interventions.filter(
    (intervention) =>
      intervention.status === 'cancelled' &&
      intervention.cancellationCause === 'suspension' &&
      intervention.cancelledAt !== null &&
      intervention.cancelledAt.getTime() >= since.getTime(),
  );
}
