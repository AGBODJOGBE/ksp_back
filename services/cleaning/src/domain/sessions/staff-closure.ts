import { addMinutes } from '../planning/time';
import { requireReason, validationFailed } from './errors';
import type { FieldSession, MissedCause, StaffClosure } from './session';
import { assertSessionTransition } from './session-status';

/**
 * R-EX-08 : quand l'équipe ne peut pas agir depuis l'application, le superviseur enregistre pour
 * elle la réalisation ou l'absence du client, avec un motif obligatoire et les agents présents ;
 * photos et liste de contrôle sont alors facultatives. La fenêtre de réclamation part de
 * l'enregistrement ; paiement et facture suivent comme pour une clôture par l'équipe.
 */
const MAX_PRESENT_AGENTS = 30;

function staffClosure(
  session: FieldSession,
  staffId: string,
  reason: string,
  presentAgentIds: readonly string[],
) {
  const present = [...new Set(presentAgentIds)];
  if (present.length === 0 || present.length > MAX_PRESENT_AGENTS) {
    throw validationFailed('presentAgentIds', present.length === 0 ? 'required' : 'out_of_range');
  }
  const assigned = new Set(session.agents.map((agent) => agent.agentId));
  if (present.some((agentId) => !assigned.has(agentId)))
    throw validationFailed('presentAgentIds', 'not_applicable');
  const closure: StaffClosure = {
    closedBy: staffId,
    reason: requireReason(reason),
    presentAgentIds: present,
  };
  return closure;
}

function assertNotInFuture(field: string, time: Date, now: Date): void {
  if (time.getTime() > now.getTime()) throw validationFailed(field, 'in_future');
}

export function completeSessionAsKsp(
  session: FieldSession,
  input: {
    staffId: string;
    reason: string;
    startedAt: Date;
    completedAt: Date;
    presentAgentIds: readonly string[];
    beforePhotoFileIds?: readonly string[];
    afterPhotoFileIds?: readonly string[];
    now: Date;
    arrivalMaxAdvanceMinutes: number;
  },
): { session: FieldSession; claimWindowStartsAt: Date } {
  assertSessionTransition(session.status, 'completed', 'staff');
  const closure = staffClosure(session, input.staffId, input.reason, input.presentAgentIds);
  assertNotInFuture('completedAt', input.completedAt, input.now);
  if (input.completedAt.getTime() <= input.startedAt.getTime())
    throw validationFailed('completedAt', 'out_of_range');
  const advance = input.arrivalMaxAdvanceMinutes;
  if (advance > 0 && input.startedAt.getTime() < addMinutes(session.scheduledStart, -advance).getTime()) {
    throw validationFailed('startedAt', 'out_of_range');
  }
  const merge = (current: string[], added: readonly string[] = []) => [...new Set([...current, ...added])];
  return {
    session: {
      ...session,
      status: 'completed',
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      beforePhotoFileIds: merge(session.beforePhotoFileIds, input.beforePhotoFileIds),
      afterPhotoFileIds: merge(session.afterPhotoFileIds, input.afterPhotoFileIds),
      staffClosure: closure,
    },
    claimWindowStartsAt: input.now,
  };
}

/**
 * Absence du client ou accès impossible enregistrés par le back-office : photo, attente et appel
 * facultatifs. Interprétation prudente : l'absence n'est pas datée avant l'heure prévue.
 */
export function reportSessionMissedAsKsp(
  session: FieldSession,
  input: {
    staffId: string;
    reason: string;
    cause: MissedCause;
    missedAt: Date;
    presentAgentIds: readonly string[];
    photoFileId?: string | null;
    waitStartedAt?: Date | null;
    calledAt?: Date | null;
    now: Date;
  },
): { session: FieldSession; claimWindowStartsAt: Date } {
  assertSessionTransition(session.status, 'missed', 'staff');
  const closure = staffClosure(session, input.staffId, input.reason, input.presentAgentIds);
  assertNotInFuture('missedAt', input.missedAt, input.now);
  if (input.missedAt.getTime() < session.scheduledStart.getTime())
    throw validationFailed('missedAt', 'out_of_range');
  return {
    session: {
      ...session,
      status: 'missed',
      missed: {
        cause: input.cause,
        missedAt: input.missedAt,
        waitStartedAt: input.waitStartedAt ?? null,
        calledAt: input.calledAt ?? null,
        photoFileId: input.photoFileId ?? null,
      },
      staffClosure: closure,
    },
    claimWindowStartsAt: input.now,
  };
}
