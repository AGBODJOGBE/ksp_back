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
 *
 * Une organisation suspendue par KSP suspend aussi ses missions (ADR-030). Les causes se
 * cumulent : « resume » lève la cause des impayés, la mission ne reprend que s'il n'en reste pas.
 */
export type StandingAction = 'none' | 'warn' | 'suspend' | 'resume';

/** Cause de suspension propre à l'organisation cliente, cumulable avec les impayés (ADR-030). */
export const ORGANIZATION_CAUSE: SuspensionCause = 'organization_suspended';

export interface StandingThresholds {
  /** Seuil d'avertissement, null s'il n'y en a pas (particulier). */
  warnAt: number | null;
  suspendAt: number;
}

const HOUR_MS = 3_600_000;

export function isBusinessContract(mission: Pick<Mission, 'organizationId'>): boolean {
  return mission.organizationId !== null;
}

export function hasSuspensionCause(mission: Pick<Mission, 'suspension'>, cause: SuspensionCause): boolean {
  return mission.suspension?.causes.includes(cause) ?? false;
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
 * Décision sur la cause des impayés : suspendre au seuil, lever la cause sous le seuil, avertir
 * (une seule fois par niveau d'impayés) entre le seuil d'avertissement et celui de suspension.
 * Une mission déjà suspendue pour une autre cause n'est pas avertie : elle est déjà arrêtée.
 */
export function decideStanding(
  state: { suspension: Suspension | null; warningLevel: number },
  cause: SuspensionCause,
  unpaid: number,
  thresholds: StandingThresholds,
): StandingAction {
  if (state.suspension?.causes.includes(cause)) return unpaid < thresholds.suspendAt ? 'resume' : 'none';
  if (unpaid >= thresholds.suspendAt) return 'suspend';
  if (state.suspension) return 'none';
  if (thresholds.warnAt !== null && unpaid >= thresholds.warnAt && unpaid > state.warningLevel) return 'warn';
  return 'none';
}

export interface SuspensionResult {
  mission: Mission;
  /** true : la mission n'était pas suspendue (début de la suspension, à annoncer). */
  started: boolean;
  cancelledInterventionIds: string[];
  releasedAgentIds: string[];
}

/**
 * Suspend la mission : les passages planifiés sont annulés (cause « suspension ») et leurs
 * agents libérés ; les passages en cours ou en attente d'incident ne sont pas touchés. Une
 * mission déjà suspendue garde sa date de début et ajoute la cause à celles qui sont actives.
 */
export function suspendMission(
  mission: Mission,
  cause: SuspensionCause,
  unpaidCount: number,
  now: Date,
): SuspensionResult {
  const current = mission.suspension;
  const cancelled = mission.interventions.filter((intervention) => intervention.status === 'planned');
  const cancelledIds = new Set(cancelled.map((intervention) => intervention.id));
  const causes = !current
    ? [cause]
    : current.causes.includes(cause)
      ? current.causes
      : [...current.causes, cause];
  return {
    started: current === null,
    mission: {
      ...mission,
      suspension: { causes, since: current?.since ?? now, unpaidCount },
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

/** Causes qui restent actives une fois `cause` levée (vide : la mission reprend). */
export function remainingCauses(suspension: Suspension, cause: SuspensionCause): SuspensionCause[] {
  return suspension.causes.filter((active) => active !== cause);
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
