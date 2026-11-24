import { ExecutionRuleError, invalidTransition, validationFailed } from './errors';
import { assertCustomerWaitElapsed, fieldActionTime } from './field-time';
import {
  assertTeamMember,
  type FieldSession,
  type Incident,
  type IncidentCategory,
  type IncidentDecision,
  type MissedCause,
} from './session';
import { assertSessionTransition } from './session-status';

/**
 * Issues d'une séance sur le terrain (partie 10) : incident et reprise, clôture, client absent.
 * Le paiement qui suit (montant dû, débit) est calculé par payments/charge.ts.
 */

function assertNotBefore(time: Date, bound: Date | null, field = 'occurredAt'): void {
  if (bound && time.getTime() < bound.getTime()) throw validationFailed(field, 'out_of_range');
}

/**
 * Incident : tout agent affecté interrompt la séance en cours, avec une note et des photos (au plus
 * `maxPhotos`, réglage « photos par type ») ; le superviseur décide ensuite. R-EX-03 : une demande
 * du client hors devis donne lieu à un avenant (`amendmentRequired`), jamais à un paiement sur place.
 */
export function reportIncident(
  session: FieldSession,
  input: {
    agentId: string;
    incidentId: string;
    category: IncidentCategory;
    note: string;
    photoFileIds: readonly string[];
    now: Date;
    occurredAt?: Date | null;
    maxPhotos: number;
  },
): { session: FieldSession; amendmentRequired: boolean } {
  assertTeamMember(session, input.agentId, false);
  assertSessionTransition(session.status, 'interrupted', 'team');
  const note = input.note.trim();
  if (note.length === 0) throw validationFailed('note', 'required');
  const photoFileIds = [...new Set(input.photoFileIds)];
  if (photoFileIds.length > input.maxPhotos) {
    throw new ExecutionRuleError('CLEANING_PHOTO_LIMIT_REACHED', {
      kind: 'incident',
      maximum: input.maxPhotos,
    });
  }
  const occurredAt = fieldActionTime(input.now, input.occurredAt);
  const incident: Incident = {
    id: input.incidentId,
    category: input.category,
    note,
    photoFileIds,
    reportedBy: input.agentId,
    occurredAt,
    decision: 'pending',
    decidedBy: null,
    decidedAt: null,
  };
  return {
    session: { ...session, status: 'interrupted', incidents: [...session.incidents, incident] },
    amendmentRequired: input.category === 'out_of_scope_request',
  };
}

/** Décision du superviseur sur l'incident en attente (reprise, report ou annulation). */
export function decidePendingIncident(
  incidents: readonly Incident[],
  decision: Exclude<IncidentDecision, 'pending'>,
  staffId: string,
  now: Date,
): Incident[] {
  return incidents.map((incident) =>
    incident.decision === 'pending'
      ? { ...incident, decision, decidedBy: staffId, decidedAt: now }
      : incident,
  );
}

/** Reprise décidée par le superviseur (ResumeSession) : la séance interrompue repasse « en cours ». */
export function resumeSession(session: FieldSession, input: { staffId: string; now: Date }): FieldSession {
  if (session.status !== 'interrupted') throw invalidTransition(session.status, 'in_progress');
  return {
    ...session,
    status: 'in_progress',
    incidents: decidePendingIncident(session.incidents, 'resumed', input.staffId, input.now),
  };
}

/**
 * Clôture par le chef d'équipe : refusée tant que la liste n'est pas complète
 * (CLEANING_CHECKLIST_INCOMPLETE) et sans photo « après » ; signature du client facultative.
 */
export function completeSession(
  session: FieldSession,
  input: { agentId: string; now: Date; occurredAt?: Date | null; signatureFileId?: string | null },
): FieldSession {
  assertTeamMember(session, input.agentId, true);
  assertSessionTransition(session.status, 'completed', 'team');
  const missing = session.checklist
    .filter((point) => !point.checked)
    .map((point) => ({ cleaningTypeCode: point.cleaningTypeCode, code: point.code }));
  if (missing.length > 0) throw new ExecutionRuleError('CLEANING_CHECKLIST_INCOMPLETE', { missing });
  if (session.afterPhotoFileIds.length === 0) {
    throw new ExecutionRuleError('CLEANING_PHOTOS_MISSING', { kind: 'after' });
  }
  const completedAt = fieldActionTime(input.now, input.occurredAt);
  assertNotBefore(completedAt, session.startedAt);
  return {
    ...session,
    status: 'completed',
    completedAt,
    signatureFileId: input.signatureFileId ?? session.signatureFileId,
  };
}

/**
 * R-EX-02 : le chef d'équipe marque la séance « manquée », avec une photo du lieu, l'attente et un
 * appel tracés. Client absent : après l'attente réglée. Interprétation prudente : un accès
 * impossible n'a pas d'attente réglée, mais aucune séance n'est manquée avant son heure prévue.
 */
export function reportCustomerAbsent(
  session: FieldSession,
  input: {
    agentId: string;
    now: Date;
    occurredAt?: Date | null;
    cause: MissedCause;
    photoFileId: string;
    waitStartedAt: Date;
    calledAt: Date;
    waitMinutes: number;
  },
): FieldSession {
  assertTeamMember(session, input.agentId, true);
  assertSessionTransition(session.status, 'missed', 'team');
  if (input.photoFileId.trim().length === 0) throw validationFailed('photoFileId', 'required');
  const missedAt = fieldActionTime(input.now, input.occurredAt);
  if (input.waitStartedAt.getTime() > missedAt.getTime())
    throw validationFailed('waitStartedAt', 'out_of_range');
  if (input.calledAt.getTime() > missedAt.getTime()) throw validationFailed('calledAt', 'out_of_range');
  assertNotBefore(missedAt, session.scheduledStart);
  if (input.cause === 'customer_absent') {
    assertCustomerWaitElapsed(session.scheduledStart, input.waitStartedAt, missedAt, input.waitMinutes);
  }
  return {
    ...session,
    status: 'missed',
    missed: {
      cause: input.cause,
      missedAt,
      waitStartedAt: input.waitStartedAt,
      calledAt: input.calledAt,
      photoFileId: input.photoFileId,
    },
  };
}
