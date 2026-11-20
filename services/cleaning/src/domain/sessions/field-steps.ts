import { assertPaymentAllowsStart, type StartPaymentContext } from '../payments/start-gate';
import { arrivalCheck, type GeoPoint } from './arrival';
import { ExecutionRuleError, invalidTransition, validationFailed } from './errors';
import { assertArrivalNotTooEarly, fieldActionTime } from './field-time';
import { assertTeamMember, type FieldSession } from './session';
import { assertSessionTransition } from './session-status';

/**
 * Étapes de la séance jusqu'au travail en cours (partie 10) : arrivée, photos « avant » et « après »,
 * démarrage, liste de contrôle. Chaque étape est horodatée de son heure réelle (R-EX-05).
 */

/** Action permise dans un seul statut, sans le changer (details.from = details.to). */
function assertStatus(session: FieldSession, status: FieldSession['status']): void {
  if (session.status !== status) throw invalidTransition(session.status, session.status);
}

/**
 * Arrivée du chef d'équipe : pas plus tôt que l'avance maximale ; position comparée à celle du lieu,
 * alerte sans blocage. Interprétation : une seconde arrivée garde la première, inchangée.
 */
export function arriveAtSession(
  session: FieldSession,
  input: {
    agentId: string;
    now: Date;
    occurredAt?: Date | null;
    position: GeoPoint | null;
    place: GeoPoint | null;
    settings: { arrivalMaxAdvanceMinutes: number; arrivalAlertMeters: number };
  },
): FieldSession {
  assertTeamMember(session, input.agentId, true);
  assertStatus(session, 'assigned');
  if (session.arrivedAt) return session;
  const arrivedAt = fieldActionTime(input.now, input.occurredAt);
  assertArrivalNotTooEarly(session.scheduledStart, arrivedAt, input.settings.arrivalMaxAdvanceMinutes);
  const arrival = arrivalCheck({
    place: input.place,
    position: input.position,
    alertMeters: input.settings.arrivalAlertMeters,
  });
  return { ...session, arrivedAt, arrival };
}

/**
 * Photo « avant » (séance pas encore démarrée) ou « après » (séance en cours) : au plus
 * `maxPerKind` de chaque ; un ajout en double est sans effet ; un fichier n'a qu'un seul type.
 */
export function addSessionPhoto(
  session: FieldSession,
  input: {
    agentId: string;
    kind: 'before' | 'after';
    fileId: string;
    now: Date;
    occurredAt?: Date | null;
    maxPerKind: number;
  },
): FieldSession {
  assertTeamMember(session, input.agentId, false);
  assertStatus(session, input.kind === 'before' ? 'assigned' : 'in_progress');
  fieldActionTime(input.now, input.occurredAt);
  const field = input.kind === 'before' ? 'beforePhotoFileIds' : 'afterPhotoFileIds';
  const other = input.kind === 'before' ? 'afterPhotoFileIds' : 'beforePhotoFileIds';
  if (session[field].includes(input.fileId)) return session;
  if (session[other].includes(input.fileId)) throw validationFailed('fileId', 'photo_kind_conflict');
  if (session[field].length >= input.maxPerKind) {
    throw new ExecutionRuleError('CLEANING_PHOTO_LIMIT_REACHED', {
      kind: input.kind,
      maximum: input.maxPerKind,
    });
  }
  return { ...session, [field]: [...session[field], input.fileId] };
}

/**
 * Démarrage par le chef d'équipe, après au moins une photo « avant » ; refusé si une séance du
 * programme est en retard de paiement ou si la garantie de solde n'est pas tenue (`payment` null :
 * entreprise). L'heure réelle n'est pas avant l'arrivée.
 */
export function startSession(
  session: FieldSession,
  input: { agentId: string; now: Date; occurredAt?: Date | null; payment: StartPaymentContext | null },
): FieldSession {
  assertTeamMember(session, input.agentId, true);
  assertSessionTransition(session.status, 'in_progress', 'team');
  if (session.beforePhotoFileIds.length === 0) {
    throw new ExecutionRuleError('CLEANING_PHOTOS_MISSING', { kind: 'before' });
  }
  const startedAt = fieldActionTime(input.now, input.occurredAt);
  if (session.arrivedAt && startedAt.getTime() < session.arrivedAt.getTime()) {
    throw validationFailed('occurredAt', 'out_of_range');
  }
  assertPaymentAllowsStart(session.id, input.payment, startedAt);
  return { ...session, status: 'in_progress', startedAt };
}

/**
 * Liste de contrôle cochée au fur et à mesure (R-EX-09) : un point est désigné par son type et son
 * code. Cocher un point déjà coché garde sa première heure (rejeu hors connexion) ; décocher l'efface.
 * Interprétation : un point absent de la séance est refusé avec la raison `not_applicable`.
 */
export function updateChecklist(
  session: FieldSession,
  input: {
    agentId: string;
    now: Date;
    occurredAt?: Date | null;
    items: ReadonlyArray<{ cleaningTypeCode: string | null; code: string; checked: boolean }>;
  },
): FieldSession {
  assertTeamMember(session, input.agentId, false);
  assertStatus(session, 'in_progress');
  const time = fieldActionTime(input.now, input.occurredAt);
  const checklist = session.checklist.map((point) => ({ ...point }));
  for (const item of input.items) {
    const point = checklist.find(
      (candidate) => candidate.code === item.code && candidate.cleaningTypeCode === item.cleaningTypeCode,
    );
    if (!point) {
      throw validationFailed('items', 'not_applicable', {
        cleaningTypeCode: item.cleaningTypeCode,
        code: item.code,
      });
    }
    if (item.checked && !point.checked) Object.assign(point, { checked: true, checkedAt: time });
    if (!item.checked) Object.assign(point, { checked: false, checkedAt: null });
  }
  return { ...session, checklist };
}
