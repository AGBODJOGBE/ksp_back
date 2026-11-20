import { invalidTransition } from './errors';

/** Statuts d'une séance (valeurs du contrat Session.status, partie 15.2). */
export const SESSION_STATUSES = [
  'to_assign',
  'assigned',
  'in_progress',
  'interrupted',
  'completed',
  'missed',
  'suspended',
  'cancelled',
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * Auteur d'une transition : l'équipe (application agent), la planification et les tâches
 * automatiques (`team`), ou le back-office (`staff`), qui a en plus les clôtures de R-EX-08.
 */
export type SessionActor = 'team' | 'staff';

const COMMON: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  to_assign: ['assigned', 'suspended', 'cancelled'],
  assigned: ['to_assign', 'in_progress', 'missed', 'suspended', 'cancelled'],
  in_progress: ['interrupted', 'completed'],
  interrupted: ['in_progress', 'cancelled', 'to_assign'],
  completed: [],
  missed: [],
  suspended: ['cancelled', 'to_assign'],
  cancelled: [],
};

/** R-EX-08 : réalisation ou absence du client enregistrées par le back-office pour l'équipe. */
const STAFF_ONLY: Readonly<Partial<Record<SessionStatus, readonly SessionStatus[]>>> = {
  assigned: ['completed'],
  interrupted: ['completed'],
  in_progress: ['missed'],
};

export function canTransitionSession(from: SessionStatus, to: SessionStatus, actor: SessionActor): boolean {
  if (COMMON[from].includes(to)) return true;
  return actor === 'staff' && (STAFF_ONLY[from]?.includes(to) ?? false);
}

export function assertSessionTransition(from: SessionStatus, to: SessionStatus, actor: SessionActor): void {
  if (!canTransitionSession(from, to, actor)) throw invalidTransition(from, to);
}

/** Séance close : réalisée, manquée ou annulée (fin d'un programme, partie 8). */
export function isClosedSession(status: SessionStatus): boolean {
  return status === 'completed' || status === 'missed' || status === 'cancelled';
}
