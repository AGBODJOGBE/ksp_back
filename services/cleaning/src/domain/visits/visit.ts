import { DomainRuleError, invalidTransition, requireReason } from '../requests/errors';
import { type TimeSlot, validateVisitSlots } from '../requests/request-lifecycle';
import {
  assertRequestTransition,
  isClosedRequestStatus,
  type RequestStatus,
} from '../requests/request-status';
import { addHours, HOUR_MS, TIME_ZONE } from '../requests/time';
import {
  feeCoveringNextVisit,
  newVisitFee,
  nextVisitFeeRank,
  refundVisitFee,
  retainVisitFee,
  type VisitFee,
} from '../requests/visit-fee';

/** Statuts d'une visite (valeurs du contrat Visit.status, partie 15.2). */
export const VISIT_STATUSES = ['scheduled', 'in_progress', 'completed', 'missed', 'cancelled'] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];

/** Cause d'une visite annulée (R-VI-06). */
export type VisitCancelCause =
  'request_cancelled' | 'request_rejected' | 'slot_changed' | 'ksp' | 'agent_no_show';

export interface Visit {
  id: string;
  /** Rang de la visite dans la demande : 1, puis 2 après une visite manquée ou annulée… */
  attempt: number;
  /** Frais qui couvrent la visite (R-VI-05, R-FV-06). */
  visitFeeId: string;
  status: VisitStatus;
  scheduledStart: Date;
  /** Durée prévue (R-VI-02 : 60 min par défaut). */
  durationMinutes: number;
  arrivedAt: Date | null;
  completedAt: Date | null;
  missedAt: Date | null;
  /** Photo du lieu quand le client est absent ; facultative pour le back-office (R-VI-08). */
  missedPhotoFileId: string | null;
  cancelledAt: Date | null;
  cancelCause: VisitCancelCause | null;
  /** Clôture ou absence enregistrée par le back-office pour l'agent (R-VI-08). */
  closedBy: string | null;
  closedReason: string | null;
}

/** Nombre de photos d'une visite (R-VI-04). */
export const MAX_VISIT_PHOTOS = 10;
/** Âge maximal de l'heure réelle d'une action gardée hors connexion (en-tête du contrat, D24). */
export const MAX_OCCURRED_AGE_HOURS = 72;

const TRANSITIONS: Readonly<Record<VisitStatus, readonly VisitStatus[]>> = {
  scheduled: ['in_progress', 'missed', 'cancelled'],
  in_progress: ['completed', 'missed', 'cancelled'],
  completed: [],
  missed: [],
  cancelled: [],
};

export function canTransitionVisit(from: VisitStatus, to: VisitStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertVisitTransition(from: VisitStatus, to: VisitStatus): void {
  if (!canTransitionVisit(from, to)) throw invalidTransition(from, to);
}

/** R-VI-01 : date au plus tôt, la plus tardive de la demande plus le délai minimum (R-DM-05) et maintenant. */
export function earliestVisitStart(requestCreatedAt: Date, now: Date, minLeadHours: number): Date {
  const lead = addHours(requestCreatedAt, minLeadHours);
  return lead.getTime() > now.getTime() ? lead : now;
}

/** RV-54 : jamais avant maintenant (`in_past`), jamais avant le délai minimum. */
export function assertVisitStart(start: Date, requestCreatedAt: Date, now: Date, minLeadHours: number): void {
  if (start.getTime() < now.getTime())
    throw new DomainRuleError('CLEANING_SLOT_INVALID', { reason: 'in_past' });
  if (start.getTime() < addHours(requestCreatedAt, minLeadHours).getTime()) {
    throw new DomainRuleError('CLEANING_LEAD_TIME_TOO_SHORT', { minimumHours: minLeadHours });
  }
}

/** Planifier une visite (UC-NT-31) : frais payés, ou visite gratuite (R-FV-06, R-VI-07). */
export function planVisit(input: {
  id: string;
  attempt: number;
  requestStatus: RequestStatus;
  fees: readonly VisitFee[];
  start: Date;
  durationMinutes: number;
  requestCreatedAt: Date;
  minLeadHours: number;
  now: Date;
}): { visit: Visit; requestStatus: 'visit_scheduled' } {
  assertRequestTransition(input.requestStatus, 'visit_scheduled');
  const fee = feeCoveringNextVisit(input.fees);
  assertVisitStart(input.start, input.requestCreatedAt, input.now, input.minLeadHours);
  return {
    visit: {
      id: input.id,
      attempt: input.attempt,
      visitFeeId: fee.id,
      status: 'scheduled',
      scheduledStart: input.start,
      durationMinutes: input.durationMinutes,
      arrivedAt: null,
      completedAt: null,
      missedAt: null,
      missedPhotoFileId: null,
      cancelledAt: null,
      cancelCause: null,
      closedBy: null,
      closedReason: null,
    },
    requestStatus: 'visit_scheduled',
  };
}

/** Déplacer une visite prévue (UpdateVisit), mêmes bornes qu'à la planification. */
export function moveVisit(
  visit: Visit,
  start: Date,
  requestCreatedAt: Date,
  now: Date,
  minLeadHours: number,
): Visit {
  if (visit.status !== 'scheduled') throw invalidTransition(visit.status, visit.status);
  assertVisitStart(start, requestCreatedAt, now, minLeadHours);
  return { ...visit, scheduledStart: start };
}

/** R-VI-02 : la visite occupe l'agenda de l'agent pendant sa durée, plus le trajet qui la précède. */
export function visitAgendaWindow(
  start: Date,
  durationMinutes: number,
  travelMinutes: number,
): { from: Date; to: Date } {
  return {
    from: new Date(start.getTime() - travelMinutes * 60_000),
    to: new Date(start.getTime() + durationMinutes * 60_000),
  };
}

/**
 * R-VI-03 : le client demande un autre créneau jusqu'à 24 h avant la visite (borne incluse) ; la visite
 * est annulée (`slot_changed`) et la demande repasse « visite à planifier » avec les nouveaux créneaux.
 */
export function changeVisitSlot(input: {
  visit: Visit;
  requestStatus: RequestStatus;
  slots: readonly TimeSlot[];
  requestCreatedAt: Date;
  minLeadHours: number;
  freeChangeHours: number;
  now: Date;
}): { visit: Visit; requestStatus: 'visit_to_schedule'; slots: readonly TimeSlot[] } {
  if (input.requestStatus !== 'visit_scheduled')
    throw invalidTransition(input.requestStatus, 'visit_to_schedule');
  const limit = addHours(input.visit.scheduledStart, -input.freeChangeHours);
  if (input.now.getTime() > limit.getTime()) throw new DomainRuleError('CLEANING_CANCELLATION_TOO_LATE');
  validateVisitSlots(input.slots, input.now, input.minLeadHours, input.requestCreatedAt);
  return {
    visit: cancelVisit(input.visit, 'slot_changed', input.now),
    requestStatus: 'visit_to_schedule',
    slots: input.slots,
  };
}

/** L'agent marque son arrivée : la visite est en cours. */
export function markArrived(visit: Visit, now: Date): Visit {
  assertVisitTransition(visit.status, 'in_progress');
  return { ...visit, status: 'in_progress', arrivedAt: now };
}

function tooEarly(visit: Visit): DomainRuleError {
  return new DomainRuleError('CLEANING_VISIT_TOO_EARLY', {
    scheduledAt: visit.scheduledStart.toISOString(),
    timeZone: TIME_ZONE,
  });
}

function occurredAtProblem(reason: 'in_future' | 'too_old' | 'out_of_range'): DomainRuleError {
  return new DomainRuleError('CLEANING_VALIDATION_FAILED', { field: 'occurredAt', reason });
}

/**
 * R-VI-04, RV-60 : constat et clôture acceptés à partir de l'heure prévue incluse. L'heure réelle
 * (`occurredAt`, hors connexion) n'est ni future, ni vieille de plus de 72 h, ni avant l'arrivée.
 */
export function observationTime(visit: Visit, now: Date, occurredAt?: Date | null): Date {
  const time = occurredAt ?? now;
  if (time.getTime() > now.getTime()) throw occurredAtProblem('in_future');
  if (now.getTime() - time.getTime() > MAX_OCCURRED_AGE_HOURS * HOUR_MS) throw occurredAtProblem('too_old');
  if (time.getTime() < visit.scheduledStart.getTime()) throw tooEarly(visit);
  if (visit.arrivedAt && time.getTime() < visit.arrivedAt.getTime()) throw occurredAtProblem('out_of_range');
  return time;
}

/** L'agent clôture la visite : la demande passe « visite faite ». */
export function completeVisit(
  visit: Visit,
  now: Date,
  occurredAt?: Date | null,
): { visit: Visit; requestStatus: 'visit_done' } {
  assertVisitTransition(visit.status, 'completed');
  const completedAt = observationTime(visit, now, occurredAt);
  return { visit: { ...visit, status: 'completed', completedAt }, requestStatus: 'visit_done' };
}

/**
 * R-VI-08 : clôture par le back-office pour l'agent, motif obligatoire, heure réelle ni future ni avant
 * l'heure prévue. Une visite encore prévue passe par « en cours » dans le même geste (15.2).
 */
export function completeVisitOnBehalf(
  visit: Visit,
  input: { staffId: string; reason: string; completedAt: Date; now: Date },
): { visit: Visit; requestStatus: 'visit_done' } {
  const started = visit.status === 'scheduled' ? 'in_progress' : visit.status;
  assertVisitTransition(visit.status, started);
  assertVisitTransition(started, 'completed');
  const reason = requireReason(input.reason);
  if (input.completedAt.getTime() > input.now.getTime()) throw occurredAtProblem('in_future');
  if (input.completedAt.getTime() < visit.scheduledStart.getTime()) throw tooEarly(visit);
  return {
    visit: {
      ...visit,
      status: 'completed',
      completedAt: input.completedAt,
      closedBy: input.staffId,
      closedReason: reason,
    },
    requestStatus: 'visit_done',
  };
}

/** R-VI-04 : 10 photos au plus par visite. */
export function assertVisitPhotoLimit(currentCount: number): void {
  if (currentCount >= MAX_VISIT_PHOTOS) {
    throw new DomainRuleError('CLEANING_PHOTO_LIMIT_REACHED', { kind: 'visit', maximum: MAX_VISIT_PHOTOS });
  }
}

/**
 * R-VI-05 : client absent, la visite est « manquée » (jamais avant son heure) ; dans la même
 * transaction, les frais de la visite sont conservés, de nouveaux frais sont créés au montant du jour
 * (échéance R-FV-03) et la demande passe `visit_missed` puis `awaiting_visit_fee`. Photo du lieu
 * obligatoire, sauf absence signalée par le back-office avec un motif (R-VI-08).
 */
export function reportClientAbsent(input: {
  visit: Visit;
  requestStatus: RequestStatus;
  fees: readonly VisitFee[];
  newFee: { id: string; amount: number };
  paymentHours: number;
  photoFileId: string | null;
  staff?: { id: string; reason: string } | null;
  now: Date;
}): { visit: Visit; requestStatus: 'awaiting_visit_fee'; fees: VisitFee[] } {
  const { visit, now } = input;
  assertVisitTransition(visit.status, 'missed');
  assertRequestTransition(input.requestStatus, 'visit_missed');
  assertRequestTransition('visit_missed', 'awaiting_visit_fee');
  if (now.getTime() < visit.scheduledStart.getTime()) throw tooEarly(visit);
  const closedReason = input.staff ? requireReason(input.staff.reason) : null;
  if (!input.staff && !input.photoFileId) {
    throw new DomainRuleError('CLEANING_VALIDATION_FAILED', { field: 'photoFileId', reason: 'required' });
  }
  const fees = input.fees.map((fee) => (fee.id === visit.visitFeeId ? retainVisitFee(fee) : fee));
  const fresh = newVisitFee({
    id: input.newFee.id,
    rank: nextVisitFeeRank(input.fees),
    amount: input.newFee.amount,
    now,
    paymentHours: input.paymentHours,
  });
  return {
    visit: {
      ...visit,
      status: 'missed',
      missedAt: now,
      missedPhotoFileId: input.photoFileId,
      closedBy: input.staff?.id ?? null,
      closedReason,
    },
    requestStatus: 'awaiting_visit_fee',
    fees: [...fees, fresh],
  };
}

/** R-VI-06 : fin d'une visite prévue ou en cours, avec sa cause, dans la transaction qui la provoque. */
export function cancelVisit(visit: Visit, cause: VisitCancelCause, now: Date): Visit {
  assertVisitTransition(visit.status, 'cancelled');
  return { ...visit, status: 'cancelled', cancelledAt: now, cancelCause: cause };
}

/**
 * R-FV-06 (RV-49) : visite annulée par KSP ou agent absent ; frais de la visite remboursés en
 * intégralité (jamais deux fois), la demande repasse « visite à planifier », la suivante est gratuite.
 */
export function cancelVisitByKsp(input: {
  visit: Visit;
  cause: 'ksp' | 'agent_no_show';
  requestStatus: RequestStatus;
  fees: readonly VisitFee[];
  now: Date;
}): { visit: Visit; requestStatus: 'visit_to_schedule'; fees: VisitFee[]; refunded: number } {
  const visit = cancelVisit(input.visit, input.cause, input.now);
  assertRequestTransition(input.requestStatus, 'visit_to_schedule');
  let refunded = 0;
  const fees = input.fees.map((fee) => {
    if (fee.id !== visit.visitFeeId) return fee;
    const result = refundVisitFee(fee, input.now);
    refunded = result.refunded;
    return result.fee;
  });
  return { visit, requestStatus: 'visit_to_schedule', fees, refunded };
}

/**
 * R-VI-06 : une visite prévue ou en cours d'une demande close est toujours affichée annulée, même avant
 * que la transaction ou la tâche ne l'ait enregistré. `requestStatus` : statut effectif de la demande.
 */
export function effectiveVisitStatus(
  visit: Pick<Visit, 'status'>,
  requestStatus: RequestStatus,
): VisitStatus {
  const live = visit.status === 'scheduled' || visit.status === 'in_progress';
  return live && isClosedRequestStatus(requestStatus) ? 'cancelled' : visit.status;
}
