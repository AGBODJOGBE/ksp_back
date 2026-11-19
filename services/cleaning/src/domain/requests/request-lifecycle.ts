import { DomainRuleError, invalidTransition, requireReason } from './errors';
import {
  assertOpenRequestLimit,
  assertRequestTransition,
  effectiveRequestStatus,
  isClosedRequestStatus,
  type RequestStatus,
  type RequestTimeline,
} from './request-status';
import { addHours } from './time';
import { newVisitFee, refundVisitFee, retainVisitFee, type VisitFee } from './visit-fee';

/** Créneau de disponibilité du client pour la visite (partie 7.1). */
export interface TimeSlot {
  start: Date;
  end: Date;
}

/** Ce que la demande sait de ses visites, sans dépendre du module des visites. */
export interface CaseVisit {
  visitFeeId: string;
  status: 'scheduled' | 'in_progress' | 'completed' | 'missed' | 'cancelled';
  scheduledStart: Date;
}

/** Cause d'annulation transmise à la visite vivante (R-VI-06). */
export type RequestVisitCancelCause = 'request_cancelled' | 'request_rejected';

export const MAX_VISIT_SLOTS = 3;

/** Motifs d'annulation par le client (RV-58) et de refus par KSP (R-AC-05), listes du contrat. */
export const CLIENT_CANCEL_REASON_CODES = [
  'no_longer_needed',
  'found_other_provider',
  'visit_fee',
  'other',
] as const;
export const KSP_REJECT_REASON_CODES = ['place_inaccessible', 'service_impossible', 'other'] as const;

/**
 * Créneaux de visite (partie 7.1) : 1 à 3, bien formés, pas dans le passé. Interprétation de R-DM-05 :
 * un créneau qui se termine avant `minLeadHours` après la demande ne peut porter aucune visite.
 * `requestCreatedAt` : date de la demande (absent : la demande est envoyée maintenant).
 */
export function validateVisitSlots(
  slots: readonly TimeSlot[],
  now: Date,
  minLeadHours: number,
  requestCreatedAt: Date = now,
): void {
  if (slots.length === 0) throw new DomainRuleError('CLEANING_SLOT_INVALID', { reason: 'malformed' });
  if (slots.length > MAX_VISIT_SLOTS)
    throw new DomainRuleError('CLEANING_SLOT_INVALID', { reason: 'too_many' });
  const earliest = addHours(requestCreatedAt, minLeadHours);
  for (const slot of slots) {
    if (slot.end.getTime() <= slot.start.getTime()) {
      throw new DomainRuleError('CLEANING_SLOT_INVALID', { reason: 'malformed' });
    }
    if (slot.start.getTime() < now.getTime()) {
      throw new DomainRuleError('CLEANING_SLOT_INVALID', { reason: 'in_past' });
    }
    if (slot.end.getTime() <= earliest.getTime()) {
      throw new DomainRuleError('CLEANING_LEAD_TIME_TOO_SHORT', { minimumHours: minLeadHours });
    }
  }
}

/**
 * Envoi de la demande (R-DM-04, R-DM-05, R-FV-02) : frais de rang 1 créés au montant du jour ; débités
 * du wallet, la demande est « visite à planifier », sinon elle attend leur paiement.
 */
export function submitRequest(input: {
  openCount: number;
  maxOpenRequests: number;
  organizationSuspended: boolean;
  slots: readonly TimeSlot[];
  minVisitLeadHours: number;
  feeId: string;
  feeAmount: number;
  paymentHours: number;
  walletDebited: boolean;
  now: Date;
}): { status: 'visit_to_schedule' | 'awaiting_visit_fee'; fee: VisitFee } {
  if (input.organizationSuspended) throw new DomainRuleError('CLEANING_ORGANIZATION_SUSPENDED');
  assertOpenRequestLimit(input.openCount, input.maxOpenRequests);
  validateVisitSlots(input.slots, input.now, input.minVisitLeadHours);
  const fee = newVisitFee({
    id: input.feeId,
    rank: 1,
    amount: input.feeAmount,
    now: input.now,
    paymentHours: input.paymentHours,
  });
  if (!input.walletDebited) return { status: 'awaiting_visit_fee', fee };
  return {
    status: 'visit_to_schedule',
    fee: { ...fee, status: 'paid', paidAt: input.now, dueAt: null },
  };
}

/** R-FV-03 : frais impayés à leur échéance, la demande est annulée par la tâche planifiée. */
export function cancelForUnpaidVisitFee(
  status: RequestStatus,
  fee: VisitFee,
  now: Date,
): { requestStatus: 'cancelled'; cause: 'visit_fee_unpaid' } {
  const dueAt = fee.status === 'awaiting_payment' ? fee.dueAt : null;
  const effective = effectiveRequestStatus({ status, pendingVisitFeeDueAt: dueAt }, now);
  if (status !== 'awaiting_visit_fee' || effective !== 'cancelled')
    throw invalidTransition(effective, 'cancelled');
  return { requestStatus: 'cancelled', cause: 'visit_fee_unpaid' };
}

function latestFee(fees: readonly VisitFee[]): VisitFee | undefined {
  return [...fees].sort((a, b) => b.rank - a.rank)[0];
}

function liveVisit(visits: readonly CaseVisit[]): CaseVisit | undefined {
  return visits.find((visit) => visit.status === 'scheduled' || visit.status === 'in_progress');
}

/**
 * Interprétation : une visite « a eu lieu » sur des frais dès que l'agent est arrivé (en cours) ou a
 * clôturé. Une nouvelle visite gratuite (R-VI-07) reste rattachée à des frais déjà consommés.
 */
function visitHappenedOnFee(visits: readonly CaseVisit[], feeId: string): boolean {
  return visits.some(
    (visit) => visit.visitFeeId === feeId && (visit.status === 'completed' || visit.status === 'in_progress'),
  );
}

const AFTER_VISIT: readonly RequestStatus[] = ['visit_done', 'quote_sent'];

/**
 * Partie 12, R-FV-06 : annulation par le client avant la visite et plus de 24 h avant (strictement) :
 * frais remboursés ; moins de 24 h avant, à 24 h exactement, ou après la visite : conservés.
 */
export function isClientCancellationRefundable(
  status: RequestStatus,
  fee: VisitFee,
  visits: readonly CaseVisit[],
  now: Date,
  freeCancellationHours: number,
): boolean {
  if (AFTER_VISIT.includes(status) || visitHappenedOnFee(visits, fee.id)) return false;
  const live = liveVisit(visits);
  if (!live) return true;
  return now.getTime() < addHours(live.scheduledStart, -freeCancellationHours).getTime();
}

function assertReasonCode(
  code: string | null | undefined,
  allowed: readonly string[],
  required: boolean,
): void {
  if (code === undefined || code === null || code === '') {
    if (required)
      throw new DomainRuleError('CLEANING_VALIDATION_FAILED', { field: 'reasonCode', reason: 'required' });
    return;
  }
  if (!allowed.includes(code)) {
    throw new DomainRuleError('CLEANING_VALIDATION_FAILED', {
      field: 'reasonCode',
      reason: 'unknown_choice',
    });
  }
}

interface ClosingOutcome<S extends RequestStatus> {
  requestStatus: S;
  fees: VisitFee[];
  /** Montant à créditer au wallet (remboursement garanti, R-FV-06) ; 0 si rien. */
  refunded: number;
  visitCancelCause: RequestVisitCancelCause | null;
}

function closeFees(
  fees: readonly VisitFee[],
  refundable: (fee: VisitFee) => boolean,
  now: Date,
): { fees: VisitFee[]; refunded: number } {
  const latest = latestFee(fees);
  if (!latest || latest.status !== 'paid') return { fees: [...fees], refunded: 0 };
  const settled = refundable(latest)
    ? refundVisitFee(latest, now)
    : { fee: retainVisitFee(latest), refunded: 0 };
  return { fees: fees.map((fee) => (fee.id === latest.id ? settled.fee : fee)), refunded: settled.refunded };
}

/** Annulation d'une demande par le client (partie 12, UC-NT-10), avant l'acceptation du devis. */
export function cancelRequestByClient(input: {
  request: RequestTimeline;
  fees: readonly VisitFee[];
  visits: readonly CaseVisit[];
  reasonCode?: string | null;
  freeCancellationHours: number;
  now: Date;
}): ClosingOutcome<'cancelled'> & { reasonCode: string | null } {
  const status = effectiveRequestStatus(input.request, input.now);
  assertRequestTransition(status, 'cancelled');
  assertReasonCode(input.reasonCode, CLIENT_CANCEL_REASON_CODES, false);
  const closed = closeFees(
    input.fees,
    (fee) =>
      isClientCancellationRefundable(status, fee, input.visits, input.now, input.freeCancellationHours),
    input.now,
  );
  return {
    requestStatus: 'cancelled',
    ...closed,
    visitCancelCause: liveVisit(input.visits) ? 'request_cancelled' : null,
    reasonCode: input.reasonCode ?? null,
  };
}

/**
 * R-AC-05 : refus par KSP à toute étape avant l'acceptation, avec un motif ; frais remboursés s'il n'y
 * a pas eu de visite (R-FV-06), conservés sinon.
 */
export function rejectRequest(input: {
  request: RequestTimeline;
  fees: readonly VisitFee[];
  visits: readonly CaseVisit[];
  reasonCode: string;
  reason: string;
  now: Date;
}): ClosingOutcome<'rejected'> & { reasonCode: string; reason: string } {
  const status = effectiveRequestStatus(input.request, input.now);
  assertRequestTransition(status, 'rejected');
  const reason = requireReason(input.reason);
  assertReasonCode(input.reasonCode, KSP_REJECT_REASON_CODES, true);
  const closed = closeFees(
    input.fees,
    (fee) => !AFTER_VISIT.includes(status) && !visitHappenedOnFee(input.visits, fee.id),
    input.now,
  );
  return {
    requestStatus: 'rejected',
    ...closed,
    visitCancelCause: liveVisit(input.visits) ? 'request_rejected' : null,
    reasonCode: input.reasonCode,
    reason,
  };
}

/** Demande de réactivation d'un devis expiré (R-AC-04). */
export interface Reactivation {
  status: 'pending' | 'accepted' | 'refused';
  requestedAt: Date;
  requestedBy: string;
  decidedAt: Date | null;
  decidedBy: string | null;
}

/** R-AC-04 : le client demande la réactivation d'un devis périmé ; rejouable sans effet. */
export function requestReactivation(
  request: RequestTimeline,
  current: Reactivation | null,
  userId: string,
  now: Date,
): Reactivation {
  const status = effectiveRequestStatus(request, now);
  if (status !== 'expired') throw invalidTransition(status, status);
  if (current?.status === 'pending') return current;
  return { status: 'pending', requestedAt: now, requestedBy: userId, decidedAt: null, decidedBy: null };
}

/**
 * R-AC-04 : le superviseur accepte (le dossier repasse « visite faite », un nouveau devis sera émis
 * aux tarifs du jour) ou refuse (le dossier reste expiré).
 */
export function decideReactivation(
  request: RequestTimeline,
  reactivation: Reactivation | null,
  decision: 'accept' | 'refuse',
  deciderId: string,
  now: Date,
): { requestStatus: RequestStatus; reactivation: Reactivation } {
  const status = effectiveRequestStatus(request, now);
  if (reactivation?.status !== 'pending') throw invalidTransition(status, status);
  const decided = { decidedAt: now, decidedBy: deciderId };
  if (decision === 'refuse') {
    if (status !== 'expired') throw invalidTransition(status, status);
    return { requestStatus: status, reactivation: { ...reactivation, ...decided, status: 'refused' } };
  }
  assertRequestTransition(status, 'visit_done');
  return { requestStatus: 'visit_done', reactivation: { ...reactivation, ...decided, status: 'accepted' } };
}

export type CaseProgramStatus = 'confirmed' | 'in_progress' | 'suspended' | 'completed' | 'cancelled';

/**
 * Interprétation de « programme en cours » (R-DM-07) : tout programme ni terminé ni annulé ;
 * confirmé ou suspendu compris, car le prix de ses séances dépend déjà de la commune.
 */
export function isProgramRunning(status: CaseProgramStatus): boolean {
  return status !== 'completed' && status !== 'cancelled';
}

/**
 * R-DM-07 : correction de la position d'un dossier. Refusée sur un dossier clos (expiré compris) ou
 * dont le programme est terminé ; si la commune change alors qu'un devis est envoyé ou qu'un programme
 * est en cours, refusée (`commune_change_locked`). Avant l'envoi du devis, une commune changée fait
 * recalculer le retenu et les brouillons à leur prochaine écriture.
 */
export function assertLocationCorrection(
  input: { request: RequestTimeline; communeChanged: boolean; program: { status: CaseProgramStatus } | null },
  now: Date,
): { recalculatePricing: boolean } {
  const status = effectiveRequestStatus(input.request, now);
  if (isClosedRequestStatus(status)) throw invalidTransition(status, status);
  if (status === 'accepted' && !(input.program && isProgramRunning(input.program.status))) {
    throw invalidTransition(status, status);
  }
  const priceLocked = status === 'quote_sent' || status === 'accepted';
  if (priceLocked && input.communeChanged) throw invalidTransition(status, status, 'commune_change_locked');
  return { recalculatePricing: input.communeChanged && !priceLocked };
}
