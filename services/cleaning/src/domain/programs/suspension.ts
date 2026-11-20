import { invalidTransition, requireReason, validationFailed } from '../sessions/errors';
import type { SessionStatus } from '../sessions/session-status';
import { hasStartedSession, isTerminalProgram, type ProgramStatus } from './program-status';

/**
 * Suspension et reprise d'un programme (partie 11.3). Causes cumulables (R-SU-01) : séances en
 * retard (particulier), factures impayées (entreprise), décision de KSP (motif obligatoire),
 * organisation suspendue. Le programme ne reprend que quand toutes les causes sont levées ; une
 * cause qui prend le relais d'une autre s'ajoute avant la levée de la première, dans le même
 * enregistrement, jamais par une reprise suivie d'une suspension.
 */
export type SuspensionCauseCode =
  'overdue_sessions' | 'unpaid_invoices' | 'ksp_decision' | 'organization_suspended';

export interface ActiveCause {
  cause: SuspensionCauseCode;
  since: Date;
  reason: string | null;
  decidedBy: string | null;
}

export interface SuspendableProgram {
  status: ProgramStatus;
  causes: ActiveCause[];
  suspendedAt: Date | null;
}

export interface SuspendableSession {
  id: string;
  status: SessionStatus;
  agentIds: readonly string[];
}

export const DEFAULT_OVERDUE_SESSIONS_BEFORE_SUSPENSION = 1;

/**
 * R-PP-04 : le programme d'un particulier est suspendu à `threshold` séances en retard (1 par
 * défaut). Interprétation reprise de la v1 : la cause est levée quand le nombre repasse sous le
 * seuil ; une séance encore en retard continue de bloquer le démarrage de la suivante.
 */
export function overdueSuspensionDecision(input: {
  status: ProgramStatus;
  causes: ReadonlyArray<{ cause: SuspensionCauseCode }>;
  overdueCount: number;
  threshold: number;
}): 'add' | 'lift' | 'none' {
  if (isTerminalProgram(input.status)) return 'none';
  const active = input.causes.some((cause) => cause.cause === 'overdue_sessions');
  if (!active && input.overdueCount >= input.threshold) return 'add';
  if (active && input.overdueCount < input.threshold) return 'lift';
  return 'none';
}

const FROZEN: readonly SessionStatus[] = ['to_assign', 'assigned'];

/**
 * Ajout d'une cause. Programme actif : il passe « suspendu » ; R-SU-02 : les séances à venir passent
 * « suspendues » et leurs agents sont libérés, une séance en cours n'est pas interrompue.
 */
export function addSuspensionCause(
  program: SuspendableProgram,
  sessions: readonly SuspendableSession[],
  input: { cause: SuspensionCauseCode; now: Date; reason?: string | null; decidedBy?: string | null },
): {
  program: SuspendableProgram;
  effect: 'suspended' | 'cause_added' | 'none';
  suspendedSessionIds: string[];
  releasedAgentIds: string[];
} {
  if (isTerminalProgram(program.status)) throw invalidTransition(program.status, 'suspended');
  let reason: string | null = input.reason?.trim() || null;
  if (input.cause === 'ksp_decision') {
    reason = requireReason(input.reason);
    if (!input.decidedBy) throw validationFailed('decidedBy', 'required');
  }
  const none = { program, suspendedSessionIds: [], releasedAgentIds: [] };
  if (program.causes.some((active) => active.cause === input.cause)) return { ...none, effect: 'none' };
  const cause: ActiveCause = {
    cause: input.cause,
    since: input.now,
    reason,
    decidedBy: input.decidedBy ?? null,
  };
  const causes = [...program.causes, cause];
  if (program.status === 'suspended')
    return { ...none, program: { ...program, causes }, effect: 'cause_added' };
  const frozen = sessions.filter((session) => FROZEN.includes(session.status));
  return {
    program: { status: 'suspended', causes, suspendedAt: input.now },
    effect: 'suspended',
    suspendedSessionIds: frozen.map((session) => session.id),
    releasedAgentIds: [...new Set(frozen.flatMap((session) => session.agentIds))].sort(),
  };
}

/**
 * Levée d'une cause. Dernière cause levée : le programme reprend, « en cours » s'il a une séance
 * démarrée ou réalisée, « confirmé » sinon ; ses séances suivent R-SU-03 (catch-up.ts).
 */
export function liftSuspensionCause(
  program: SuspendableProgram,
  sessions: ReadonlyArray<{ status: SessionStatus }>,
  input: { cause: SuspensionCauseCode },
): { program: SuspendableProgram; effect: 'resumed' | 'cause_lifted' | 'none' } {
  if (!program.causes.some((active) => active.cause === input.cause)) return { program, effect: 'none' };
  const causes = program.causes.filter((active) => active.cause !== input.cause);
  if (causes.length > 0) return { program: { ...program, causes }, effect: 'cause_lifted' };
  const status: ProgramStatus = hasStartedSession(sessions) ? 'in_progress' : 'confirmed';
  return { program: { status, causes, suspendedAt: null }, effect: 'resumed' };
}
