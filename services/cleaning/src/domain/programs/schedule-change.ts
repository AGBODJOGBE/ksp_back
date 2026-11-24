import { localPosition, overlaps } from '../planning/time';
import { ExecutionRuleError, invalidTransition, requireReason, validationFailed } from '../sessions/errors';
import type { Reschedule } from '../sessions/reschedule';
import type { SessionStatus } from '../sessions/session-status';
import type { ProgramStatus } from './program-status';

/**
 * Changement du jour ou de l'heure des séances à venir (R-PG-06, R-RP-01), décidé par KSP à la
 * demande du client. Domaine pur : les nouvelles dates viennent du moteur de plan ; ici, seules les
 * conditions et l'appariement séance → nouvelle date sont décidés. Le prix ne change jamais : un
 * plan qui ne donne pas le même nombre de séances passe par un avenant.
 */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MIN_DURATION_MINUTES = 15;
const MAX_DURATION_MINUTES = 24 * 60;

export interface ScheduleChangeSession {
  id: string;
  rank: number;
  status: SessionStatus;
  scheduledStart: Date;
  scheduledEnd: Date;
}

export interface ScheduleChangeInput {
  /** Premier jour concerné (AAAA-MM-JJ, Porto-Novo). */
  effectiveFrom: string;
  /** Dates du nouveau plan, dans l'ordre. */
  newStarts: readonly Date[];
  /** Nouvelle durée d'une séance ; null : chaque séance garde la sienne. */
  durationMinutes: number | null;
  reason: string;
  actorId: string;
  now: Date;
}

export interface SessionMove {
  sessionId: string;
  rank: number;
  /** Les agents sont retirés : la séance est de nouveau « à affecter ». */
  status: 'to_assign';
  wasAssigned: boolean;
  scheduledStart: Date;
  scheduledEnd: Date;
  /** Ancienne date gardée dans l'historique des reports. */
  reschedule: Reschedule;
}

export interface ScheduleChange {
  moves: SessionMove[];
  /** Nouvelle durée du programme ; null : inchangée. */
  durationMinutes: number | null;
}

/** Séance concernée : ni démarrée ni close, elle commence le jour d'effet ou après. */
function concerned(session: ScheduleChangeSession, effectiveFrom: string): boolean {
  return (
    (session.status === 'to_assign' || session.status === 'assigned') &&
    localPosition(session.scheduledStart).day >= effectiveFrom
  );
}

export function changeSchedule(
  program: { status: ProgramStatus; causes: readonly string[] },
  sessions: readonly ScheduleChangeSession[],
  input: ScheduleChangeInput,
): ScheduleChange {
  if (program.status === 'suspended') {
    throw new ExecutionRuleError('CLEANING_PROGRAM_SUSPENDED', { causes: [...program.causes] });
  }
  if (program.status !== 'confirmed' && program.status !== 'in_progress') {
    throw invalidTransition(program.status, program.status, 'program_closed');
  }
  const reason = requireReason(input.reason);
  if (!DAY_PATTERN.test(input.effectiveFrom)) throw validationFailed('effectiveFrom', 'invalid_type');
  const duration = input.durationMinutes;
  if (
    duration !== null &&
    (!Number.isInteger(duration) || duration < MIN_DURATION_MINUTES || duration > MAX_DURATION_MINUTES)
  ) {
    throw validationFailed('durationMinutes', 'out_of_range');
  }
  if (input.newStarts.length === 0) throw new ExecutionRuleError('CLEANING_SCHEDULE_EMPTY');

  const targets = sessions
    .filter((session) => concerned(session, input.effectiveFrom))
    .sort((a, b) => a.rank - b.rank);
  if (targets.length !== input.newStarts.length) {
    throw new ExecutionRuleError('CLEANING_AMENDMENT_REQUIRED', {
      sessions: targets.length,
      planned: input.newStarts.length,
    });
  }
  const starts = [...input.newStarts].sort((a, b) => a.getTime() - b.getTime());
  if (starts.some((start) => start <= input.now || localPosition(start).day < input.effectiveFrom)) {
    throw validationFailed('schedule', 'out_of_range');
  }

  const targetIds = new Set(targets.map((session) => session.id));
  const kept = sessions.filter((session) => !targetIds.has(session.id) && session.status !== 'cancelled');
  const moves: SessionMove[] = [];
  targets.forEach((session, index) => {
    const scheduledStart = starts[index]!;
    const length =
      duration ?? Math.round((session.scheduledEnd.getTime() - session.scheduledStart.getTime()) / 60_000);
    const scheduledEnd = new Date(scheduledStart.getTime() + length * 60_000);
    const clash = kept.find((other) =>
      overlaps(
        { start: other.scheduledStart, end: other.scheduledEnd },
        { start: scheduledStart, end: scheduledEnd },
      ),
    );
    if (clash) throw new ExecutionRuleError('CLEANING_RESCHEDULE_OVERLAP', { sessionId: clash.id });
    if (
      scheduledStart.getTime() === session.scheduledStart.getTime() &&
      scheduledEnd.getTime() === session.scheduledEnd.getTime()
    ) {
      return;
    }
    moves.push({
      sessionId: session.id,
      rank: session.rank,
      status: 'to_assign',
      wasAssigned: session.status === 'assigned',
      scheduledStart,
      scheduledEnd,
      reschedule: {
        previousStart: session.scheduledStart,
        previousEnd: session.scheduledEnd,
        newStart: scheduledStart,
        newEnd: scheduledEnd,
        by: 'ksp',
        at: input.now,
        reason,
        actorId: input.actorId,
      },
    });
  });
  return { moves, durationMinutes: duration };
}
