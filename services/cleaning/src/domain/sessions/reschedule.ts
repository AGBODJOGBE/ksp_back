import { localPosition, overlaps, type Period } from '../planning/time';
import type { ProgramStatus } from '../programs/program-status';
import { isWithinFreePeriod } from './cancellation';
import { ExecutionRuleError, invalidTransition, requireReason, validationFailed } from './errors';
import type { SessionStatus } from './session-status';

/**
 * R-RP-01 : un report n'est pas un statut ; la séance garde son statut et change de date, ses dates
 * précédentes restent dans son historique. Le nouveau créneau ne chevauche aucune autre séance non
 * annulée du programme ; aucun report tant que le programme est suspendu.
 */
export const DEFAULT_RESCHEDULES_PER_MONTH = 2;
const MIN_DURATION_MINUTES = 15;
const MAX_DURATION_MINUTES = 24 * 60;

export interface ReschedulableSession {
  id: string;
  status: SessionStatus;
  scheduledStart: Date;
  scheduledEnd: Date;
  catchUpSuggestedStart?: Date | null;
}

export interface Reschedule {
  previousStart: Date;
  previousEnd: Date;
  newStart: Date;
  newEnd: Date;
  by: 'customer' | 'ksp';
  at: Date;
  reason: string | null;
  actorId: string;
}

export interface RescheduledSession {
  status: SessionStatus;
  scheduledStart: Date;
  scheduledEnd: Date;
  catchUpSuggestedStart: null;
  reschedule: Reschedule;
}

interface ProgramContext {
  programStatus: ProgramStatus;
  programCauses?: readonly string[];
  programSessions: readonly ReschedulableSession[];
}

function assertProgramNotSuspended(context: ProgramContext): void {
  if (context.programStatus !== 'suspended') return;
  throw new ExecutionRuleError('CLEANING_PROGRAM_SUSPENDED', { causes: [...(context.programCauses ?? [])] });
}

function assertNoOverlap(session: ReschedulableSession, slot: Period, context: ProgramContext): void {
  const clash = context.programSessions.find(
    (other) =>
      other.id !== session.id &&
      other.status !== 'cancelled' &&
      overlaps({ start: other.scheduledStart, end: other.scheduledEnd }, slot),
  );
  if (clash) throw new ExecutionRuleError('CLEANING_RESCHEDULE_OVERLAP', { sessionId: clash.id });
}

function moved(
  session: ReschedulableSession,
  status: SessionStatus,
  slot: Period,
  by: Reschedule['by'],
  at: Date,
  reason: string | null,
  actorId: string,
): RescheduledSession {
  return {
    status,
    scheduledStart: slot.start,
    scheduledEnd: slot.end,
    catchUpSuggestedStart: null,
    reschedule: {
      previousStart: session.scheduledStart,
      previousEnd: session.scheduledEnd,
      newStart: slot.start,
      newEnd: slot.end,
      by,
      at,
      reason,
      actorId,
    },
  };
}

/**
 * Interprétation du plafond « 2 reports par mois » : reports faits par le client sur le programme,
 * dans le mois civil de Porto-Novo où il reporte (historique du programme fourni par l'appelant).
 */
export function customerReschedulesInMonth(
  reschedules: ReadonlyArray<{ by: 'customer' | 'ksp'; at: Date }>,
  now: Date,
): number {
  const month = localPosition(now).day.slice(0, 7);
  return reschedules.filter(
    (line) => line.by === 'customer' && localPosition(line.at).day.slice(0, 7) === month,
  ).length;
}

/** Report par le client : plus de 24 h avant, vers une date au-delà du délai sans frais. */
export function rescheduleByCustomer(
  session: ReschedulableSession,
  input: ProgramContext & {
    newStart: Date;
    actorId: string;
    now: Date;
    freeCancellationHours: number;
    reschedulesPerMonth: number;
    reschedulesThisMonth: number;
  },
): RescheduledSession {
  assertProgramNotSuspended(input);
  if (session.status !== 'to_assign' && session.status !== 'assigned') {
    throw invalidTransition(session.status, session.status);
  }
  const hours = input.freeCancellationHours;
  if (!isWithinFreePeriod(session.scheduledStart, input.now, hours)) {
    throw new ExecutionRuleError('CLEANING_CANCELLATION_TOO_LATE', { freeCancellationHours: hours });
  }
  if (!isWithinFreePeriod(input.newStart, input.now, hours)) {
    throw new ExecutionRuleError('CLEANING_LEAD_TIME_TOO_SHORT', { minimumHours: hours });
  }
  if (input.reschedulesThisMonth >= input.reschedulesPerMonth) {
    throw new ExecutionRuleError('CLEANING_RESCHEDULE_LIMIT_REACHED', { maximum: input.reschedulesPerMonth });
  }
  const duration = session.scheduledEnd.getTime() - session.scheduledStart.getTime();
  const slot = { start: input.newStart, end: new Date(input.newStart.getTime() + duration) };
  assertNoOverlap(session, slot, input);
  return moved(session, session.status, slot, 'customer', input.now, null, input.actorId);
}

/** Statut d'une séance reportée par KSP : interrompue ou suspendue, elle repasse « à affecter » (15.2). */
const KSP_RESCHEDULE_STATUS: Partial<Record<SessionStatus, SessionStatus>> = {
  to_assign: 'to_assign',
  assigned: 'assigned',
  interrupted: 'to_assign',
  suspended: 'to_assign',
};

/**
 * Report par KSP : motif obligatoire, nouveau début dans le futur, durée modifiable de 15 min à 24 h
 * sans changer le prix. Une séance suspendue se reporte après la reprise (rattrapage, R-SU-03).
 */
export function rescheduleByKsp(
  session: ReschedulableSession,
  input: ProgramContext & {
    newStart: Date;
    durationMinutes?: number | null;
    reason: string;
    actorId: string;
    now: Date;
  },
): RescheduledSession {
  const reason = requireReason(input.reason);
  assertProgramNotSuspended(input);
  const status = KSP_RESCHEDULE_STATUS[session.status];
  if (!status) throw invalidTransition(session.status, session.status);
  if (input.newStart.getTime() <= input.now.getTime()) {
    throw new ExecutionRuleError('CLEANING_SLOT_INVALID', { reason: 'in_past' });
  }
  const minutes = input.durationMinutes;
  if (
    minutes != null &&
    (!Number.isInteger(minutes) || minutes < MIN_DURATION_MINUTES || minutes > MAX_DURATION_MINUTES)
  ) {
    throw validationFailed('durationMinutes', 'out_of_range');
  }
  const duration =
    minutes != null ? minutes * 60_000 : session.scheduledEnd.getTime() - session.scheduledStart.getTime();
  const slot = { start: input.newStart, end: new Date(input.newStart.getTime() + duration) };
  assertNoOverlap(session, slot, input);
  return moved(session, status, slot, 'ksp', input.now, reason, input.actorId);
}

/**
 * Agents recontrôlés au nouveau créneau (contrôles non contournables, faits par la planification) :
 * ceux qui passent sont gardés, les autres retirés ; une séance planifiée dont l'équipe devient
 * incomplète repasse « à affecter ».
 */
export function recheckAgents(input: {
  status: SessionStatus;
  teamSize: number;
  agents: ReadonlyArray<{ agentId: string; passes: boolean }>;
}): { keptAgentIds: string[]; removedAgentIds: string[]; status: SessionStatus } {
  const keptAgentIds = input.agents.filter((agent) => agent.passes).map((agent) => agent.agentId);
  const removedAgentIds = input.agents.filter((agent) => !agent.passes).map((agent) => agent.agentId);
  const incomplete = input.status === 'assigned' && keptAgentIds.length < input.teamSize;
  return { keptAgentIds, removedAgentIds, status: incomplete ? 'to_assign' : input.status };
}
