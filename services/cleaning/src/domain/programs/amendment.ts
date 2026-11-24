import { ExecutionRuleError, invalidTransition, validationFailed } from '../sessions/errors';
import type { SessionStatus } from '../sessions/session-status';
import type { ProgramStatus } from './program-status';

/**
 * Avenant d'un programme (R-PG-06, R-EX-03) : ajouter un type de nettoyage ou des séances. Domaine
 * pur : conditions, séances que l'avenant peut changer, effet de l'avenant accepté. Une séance déjà
 * payée, démarrée ou close ne change jamais ; les séances ajoutées prennent rang à la suite.
 */
export interface AmendmentSession {
  id: string;
  rank: number;
  status: SessionStatus;
  paymentStatus: string | null;
  scheduledStart: Date;
  scheduledEnd: Date;
  /** Part des frais de visite déjà réservée à la séance (R-FV-05). */
  visitFeeDeducted?: number;
}

/** Programme confirmé ou en cours ; suspendu : CLEANING_PROGRAM_SUSPENDED (details.causes). */
export function assertAmendable(program: { status: ProgramStatus; causes: readonly string[] }): void {
  if (program.status === 'suspended') {
    throw new ExecutionRuleError('CLEANING_PROGRAM_SUSPENDED', { causes: [...program.causes] });
  }
  if (program.status !== 'confirmed' && program.status !== 'in_progress') {
    throw invalidTransition(program.status, program.status, 'program_closed');
  }
}

/** Séances que l'avenant peut changer : ni démarrées, ni closes, ni déjà payées. */
export function amendableSessions<T extends AmendmentSession>(sessions: readonly T[]): T[] {
  return sessions.filter(
    (session) =>
      (session.status === 'to_assign' || session.status === 'assigned' || session.status === 'suspended') &&
      (session.paymentStatus === null || session.paymentStatus === 'not_due'),
  );
}

/**
 * Demande d'avenant : au moins un type ajouté ou une séance ajoutée ; un type déjà au programme ou
 * une date déjà occupée par une séance du programme sont refusés.
 */
export function requestedAmendment(input: {
  currentTypeIds: readonly string[];
  addTypeIds: readonly string[];
  addedStarts: readonly Date[];
  sessions: readonly AmendmentSession[];
}): { addedTypeIds: string[]; addedStarts: Date[] } {
  const addedTypeIds = [...new Set(input.addTypeIds)];
  if (addedTypeIds.length === 0 && input.addedStarts.length === 0) {
    throw validationFailed('addCleaningTypeIds', 'required');
  }
  if (addedTypeIds.some((id) => input.currentTypeIds.includes(id))) {
    throw validationFailed('addCleaningTypeIds', 'duplicate');
  }
  const taken = new Set(
    input.sessions
      .filter((session) => session.status !== 'cancelled')
      .map((session) => session.scheduledStart.getTime()),
  );
  const addedStarts = [...input.addedStarts].sort((a, b) => a.getTime() - b.getTime());
  if (addedStarts.some((start) => taken.has(start.getTime()))) {
    throw validationFailed('addSchedule', 'duplicate');
  }
  return { addedTypeIds, addedStarts };
}

export interface AmendmentTerms {
  sessionPrice: number;
  teamSize: number;
  durationMinutes: number;
  addedStarts: readonly Date[];
}

export interface AppliedAmendment {
  /** Séances non démarrées : nouveau prix, nouvelle durée ; `release` : agents à retirer. */
  updated: { sessionId: string; price: number; scheduledEnd: Date; release: boolean }[];
  added: { rank: number; scheduledStart: Date; scheduledEnd: Date; price: number }[];
  /** Séances au prix de l'avenant (changées et ajoutées). */
  sessionsCount: number;
}

/**
 * Effet de l'avenant accepté. Si l'équipe ou la durée change, les séances déjà planifiées sont de
 * nouveau « à affecter » : leur créneau ou leur effectif n'est plus celui qui a été contrôlé.
 */
export function applyAmendment(
  program: { status: ProgramStatus; causes: readonly string[]; teamSize: number; durationMinutes: number },
  sessions: readonly AmendmentSession[],
  terms: AmendmentTerms,
): AppliedAmendment {
  assertAmendable(program);
  const staffingChanged =
    terms.teamSize !== program.teamSize || terms.durationMinutes !== program.durationMinutes;
  const end = (start: Date) => new Date(start.getTime() + terms.durationMinutes * 60_000);
  const amendable = amendableSessions(sessions);
  // Le prix d'une séance ne descend jamais sous les frais de visite qui lui sont déjà déduits.
  if (amendable.some((session) => (session.visitFeeDeducted ?? 0) > terms.sessionPrice)) {
    throw validationFailed('sessionPrice', 'out_of_range');
  }
  const updated = amendable.map((session) => ({
    sessionId: session.id,
    price: terms.sessionPrice,
    scheduledEnd: end(session.scheduledStart),
    release: staffingChanged && session.status === 'assigned',
  }));
  const lastRank = sessions.reduce((max, session) => Math.max(max, session.rank), 0);
  const added = [...terms.addedStarts]
    .sort((a, b) => a.getTime() - b.getTime())
    .map((scheduledStart, index) => ({
      rank: lastRank + index + 1,
      scheduledStart,
      scheduledEnd: end(scheduledStart),
      price: terms.sessionPrice,
    }));
  return { updated, added, sessionsCount: updated.length + added.length };
}
