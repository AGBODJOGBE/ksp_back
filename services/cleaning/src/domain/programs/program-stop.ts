import { isWithinFreePeriod } from '../sessions/cancellation';
import { ExecutionRuleError, requireReason } from '../sessions/errors';
import type { SessionStatus } from '../sessions/session-status';
import { assertProgramTransition, type ProgramStatus } from './program-status';

/**
 * Arrêt d'un programme (partie 12). Les séances réalisées restent dues ; les séances à venir sont
 * annulées (cause `program_stopped`), sans rien à payer : chaque séance est payée après coup, il n'y
 * a donc aucun remboursement à faire. Une séance en cours ou interrompue suit sa propre issue.
 */
interface StoppableSession {
  id: string;
  status: SessionStatus;
  scheduledStart: Date;
}

const UPCOMING: readonly SessionStatus[] = ['to_assign', 'assigned', 'suspended'];
/** Séances qui auront lieu : seules elles peuvent être maintenues par la règle des 24 h. */
const WILL_HAPPEN: readonly SessionStatus[] = ['to_assign', 'assigned'];

function upcoming(sessions: readonly StoppableSession[]): StoppableSession[] {
  return sessions
    .filter((session) => UPCOMING.includes(session.status))
    .sort((a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime() || a.id.localeCompare(b.id));
}

/**
 * Arrêt par le client (StopProgram) : règle des 24 h pour la plus proche, qui est maintenue si elle
 * est à moins de 24 h. Interprétation : seule une séance qui aura lieu (à affecter ou planifiée) est
 * maintenue, jamais une séance gelée par la suspension.
 */
export function stopProgramByCustomer(
  program: { status: ProgramStatus },
  sessions: readonly StoppableSession[],
  input: { now: Date; freeCancellationHours: number },
): { status: 'cancelled'; cancelledSessionIds: string[]; maintainedSessionId: string | null } {
  assertProgramTransition(program.status, 'cancelled');
  const candidates = upcoming(sessions);
  const nearest = candidates.find((session) => WILL_HAPPEN.includes(session.status));
  const maintained =
    nearest && !isWithinFreePeriod(nearest.scheduledStart, input.now, input.freeCancellationHours)
      ? nearest
      : null;
  return {
    status: 'cancelled',
    cancelledSessionIds: candidates.filter((session) => session !== maintained).map((session) => session.id),
    maintainedSessionId: maintained?.id ?? null,
  };
}

/** Arrêt par KSP : motif obligatoire, validé par un admin autre que l'auteur de la demande. */
export function cancelProgramByKsp(
  program: { status: ProgramStatus },
  sessions: readonly StoppableSession[],
  input: { reason: string; requestedBy: string; approvedBy: string },
): { status: 'cancelled'; cancelledSessionIds: string[] } {
  requireReason(input.reason);
  if (input.requestedBy === input.approvedBy)
    throw new ExecutionRuleError('CLEANING_SECOND_APPROVER_REQUIRED');
  assertProgramTransition(program.status, 'cancelled');
  return { status: 'cancelled', cancelledSessionIds: upcoming(sessions).map((session) => session.id) };
}
