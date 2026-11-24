import { invalidTransition } from '../sessions/errors';
import { isClosedSession, type SessionStatus } from '../sessions/session-status';

/** Statuts d'un programme (valeurs du contrat Program.status, partie 15.2). */
export const PROGRAM_STATUSES = ['confirmed', 'in_progress', 'suspended', 'completed', 'cancelled'] as const;
export type ProgramStatus = (typeof PROGRAM_STATUSES)[number];

const TRANSITIONS: Readonly<Record<ProgramStatus, readonly ProgramStatus[]>> = {
  confirmed: ['in_progress', 'suspended', 'cancelled'],
  in_progress: ['completed', 'suspended', 'cancelled'],
  suspended: ['confirmed', 'in_progress', 'cancelled'],
  completed: [],
  cancelled: [],
};

export function canTransitionProgram(from: ProgramStatus, to: ProgramStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertProgramTransition(from: ProgramStatus, to: ProgramStatus): void {
  if (!canTransitionProgram(from, to)) throw invalidTransition(from, to);
}

export function isTerminalProgram(status: ProgramStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}

const STARTED: readonly SessionStatus[] = ['in_progress', 'interrupted', 'completed'];

/** « En cours » : au moins une séance réalisée ou démarrée (partie 8). */
export function hasStartedSession(sessions: ReadonlyArray<{ status: SessionStatus }>): boolean {
  return sessions.some((session) => STARTED.includes(session.status));
}

/**
 * Transitions à appliquer d'après les séances : « en cours » dès une séance démarrée ou réalisée ;
 * « terminé » quand toutes sont réalisées, manquées ou annulées, donc sans séance à affecter ni
 * planifiée (R-PL-10). Interprétation : un programme confirmé dont toutes les séances sont closes
 * sans qu'aucune ait démarré passe par « en cours » dans le même geste (15.2 n'a pas
 * confirmed → completed). Un programme suspendu progresse à sa reprise.
 */
export function programProgress(
  status: ProgramStatus,
  sessions: ReadonlyArray<{ status: SessionStatus }>,
): ProgramStatus[] {
  if (status !== 'confirmed' && status !== 'in_progress') return [];
  const allClosed = sessions.length > 0 && sessions.every((session) => isClosedSession(session.status));
  const path: ProgramStatus[] = [];
  if (status === 'confirmed' && (allClosed || hasStartedSession(sessions))) path.push('in_progress');
  if (allClosed) path.push('completed');
  return path;
}
