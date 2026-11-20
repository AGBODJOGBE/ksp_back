import { localPosition, overlaps, type Period } from '../planning/time';
import { addHours } from '../requests/time';
import type { SessionStatus } from '../sessions/session-status';

/**
 * R-SU-03 (RV-77) : à la reprise d'un programme, les séances suspendues dont le début est après
 * maintenant plus le délai minimum (`firstSessionLeadHours`) repassent « à affecter » ; les autres
 * reçoivent une date de rattrapage proposée — même jour de la semaine et même heure, N semaines plus
 * tard, hors jours exclus et fériés, sans chevaucher une autre séance du programme. Le superviseur
 * confirme le rattrapage par un report, ou annule la séance.
 */
const WEEK_MS = 7 * 24 * 3_600_000;

export interface ResumableSession {
  id: string;
  rank: number;
  status: SessionStatus;
  scheduledStart: Date;
  scheduledEnd: Date;
}

export interface CatchUpProposal {
  sessionId: string;
  rank: number;
  previousStart: Date;
  /** null : aucune date libre trouvée dans la limite. */
  suggestedStart: Date | null;
}

/**
 * Première date libre, N semaines entières après la date d'origine (N ≥ 1), strictement après
 * `earliestExclusive`. Porto-Novo n'a pas d'heure d'été : ajouter 7 × 24 h garde le jour de la
 * semaine et l'heure locale. Interprétation : la recherche s'arrête à `maxWeeks`, limite fixée par
 * l'appelant (le cahier des charges n'en donne pas).
 */
export function catchUpStart(input: {
  start: Date;
  durationMs: number;
  earliestExclusive: Date;
  excludedDays: ReadonlySet<string>;
  busy: readonly Period[];
  maxWeeks: number;
}): Date | null {
  for (let weeks = 1; weeks <= input.maxWeeks; weeks += 1) {
    const start = new Date(input.start.getTime() + weeks * WEEK_MS);
    if (start.getTime() <= input.earliestExclusive.getTime()) continue;
    if (input.excludedDays.has(localPosition(start).day)) continue;
    const slot = { start, end: new Date(start.getTime() + input.durationMs) };
    if (input.busy.some((period) => overlaps(period, slot))) continue;
    return start;
  }
  return null;
}

export function resumeSessions(input: {
  sessions: readonly ResumableSession[];
  now: Date;
  firstSessionLeadHours: number;
  /** Jours exclus du plan et jours fériés (AAAA-MM-JJ, Porto-Novo). */
  excludedDays: ReadonlySet<string>;
  maxWeeks: number;
}): { toAssign: string[]; catchUp: CatchUpProposal[] } {
  const earliest = addHours(input.now, input.firstSessionLeadHours);
  const suspended = input.sessions
    .filter((session) => session.status === 'suspended')
    .sort((a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime() || a.rank - b.rank);
  const toAssign = suspended.filter((session) => session.scheduledStart.getTime() > earliest.getTime());
  const late = suspended.filter((session) => !toAssign.includes(session));
  const busy: Period[] = input.sessions
    .filter((session) => session.status !== 'cancelled' && !late.includes(session))
    .map((session) => ({ start: session.scheduledStart, end: session.scheduledEnd }));
  const catchUp = late.map((session) => {
    const durationMs = session.scheduledEnd.getTime() - session.scheduledStart.getTime();
    const suggestedStart = catchUpStart({
      start: session.scheduledStart,
      durationMs,
      earliestExclusive: earliest,
      excludedDays: input.excludedDays,
      busy,
      maxWeeks: input.maxWeeks,
    });
    if (suggestedStart)
      busy.push({ start: suggestedStart, end: new Date(suggestedStart.getTime() + durationMs) });
    return {
      sessionId: session.id,
      rank: session.rank,
      previousStart: session.scheduledStart,
      suggestedStart,
    };
  });
  return { toAssign: toAssign.map((session) => session.id), catchUp };
}
