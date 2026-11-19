import { addMinutes } from './time';

/**
 * Couverture d'une séance (R-PL-06, R-PL-10) : niveau de l'alerte cleaning.session.staffing_alert
 * d'après l'heure, et annulation faute d'agent. Toutes les bornes sont incluses : l'alerte part à
 * l'instant même où le seuil est atteint.
 */
export type StaffingAlertLevel = 'unassigned_48h' | 'unassigned_at_start' | 'agent_absent';

export interface StaffingSession {
  /** Statut de la séance (15.2). */
  status: string;
  scheduledStart: Date;
  scheduledEnd: Date;
}

/** Ordre des niveaux : une alerte n'est envoyée qu'une fois par niveau, jamais en redescendant. */
const RANK: Readonly<Record<StaffingAlertLevel, number>> = {
  unassigned_48h: 1,
  unassigned_at_start: 2,
  agent_absent: 3,
};

const UNASSIGNED_ALERT_MINUTES_BEFORE = 48 * 60;
const AGENT_ABSENT_MINUTES_AFTER = 60;

/**
 * - « à affecter » 48 h avant le début : unassigned_48h (alerte à l'admin, R-PL-06) ;
 * - « à affecter » à l'heure de début : unassigned_at_start (R-PL-10) ;
 * - « planifiée » non démarrée 1 h après le début : agent_absent (R-PL-10, partie 12).
 */
export function staffingAlertLevel(session: StaffingSession, now: Date): StaffingAlertLevel | null {
  if (session.status === 'to_assign') {
    if (now >= session.scheduledStart) return 'unassigned_at_start';
    if (now >= addMinutes(session.scheduledStart, -UNASSIGNED_ALERT_MINUTES_BEFORE)) return 'unassigned_48h';
    return null;
  }
  if (
    session.status === 'assigned' &&
    now >= addMinutes(session.scheduledStart, AGENT_ABSENT_MINUTES_AFTER)
  ) {
    return 'agent_absent';
  }
  return null;
}

/** Alerte à envoyer maintenant, compte tenu de la dernière envoyée (Session.staffingAlertLevel). */
export function staffingAlertToSend(
  session: StaffingSession,
  lastSent: StaffingAlertLevel | null,
  now: Date,
): StaffingAlertLevel | null {
  const level = staffingAlertLevel(session, now);
  if (level === null || (lastSent !== null && RANK[level] <= RANK[lastSent])) return null;
  return level;
}

/** R-PL-10 : séance encore « à affecter » à l'heure de fin prévue, annulée par KSP (cause no_agent). */
export function isCancelledForNoAgent(session: StaffingSession, now: Date): boolean {
  return session.status === 'to_assign' && now >= session.scheduledEnd;
}
