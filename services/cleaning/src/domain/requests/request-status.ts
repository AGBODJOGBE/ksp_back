import { DomainRuleError, invalidTransition } from './errors';
import { isPastDeadline } from './time';

/** Statuts d'une demande de devis (valeurs du contrat Request.status, partie 15.2). */
export const REQUEST_STATUSES = [
  'awaiting_visit_fee',
  'visit_to_schedule',
  'visit_scheduled',
  'visit_missed',
  'visit_done',
  'quote_sent',
  'accepted',
  'declined',
  'expired',
  'cancelled',
  'rejected',
] as const;

export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** Avant l'acceptation : annulation par le client (partie 12) et refus par KSP (R-AC-05). */
const BEFORE_ACCEPTANCE_EXITS: readonly RequestStatus[] = ['cancelled', 'rejected'];

/**
 * Transitions de la partie 15.2. `visit_missed` n'est qu'un passage, dans la même transaction, vers
 * `awaiting_visit_fee` (R-VI-05) : il n'a pas d'autre sortie. Un dossier clos ne bouge plus, sauf la
 * réactivation acceptée d'un devis expiré (R-AC-04).
 */
const TRANSITIONS: Readonly<Record<RequestStatus, readonly RequestStatus[]>> = {
  awaiting_visit_fee: ['visit_to_schedule', ...BEFORE_ACCEPTANCE_EXITS],
  visit_to_schedule: ['visit_scheduled', ...BEFORE_ACCEPTANCE_EXITS],
  visit_scheduled: ['visit_done', 'visit_to_schedule', 'visit_missed', ...BEFORE_ACCEPTANCE_EXITS],
  visit_missed: ['awaiting_visit_fee'],
  visit_done: ['quote_sent', 'visit_to_schedule', ...BEFORE_ACCEPTANCE_EXITS],
  quote_sent: ['accepted', 'declined', 'expired', 'visit_to_schedule', ...BEFORE_ACCEPTANCE_EXITS],
  accepted: [],
  declined: [],
  expired: ['visit_done'],
  cancelled: [],
  rejected: [],
};

export function canTransitionRequest(from: RequestStatus, to: RequestStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertRequestTransition(from: RequestStatus, to: RequestStatus): void {
  if (!canTransitionRequest(from, to)) throw invalidTransition(from, to);
}

/** Dossier clos sans programme : refusé, expiré, annulé ou refusé par KSP. */
const CLOSED_STATUSES: readonly RequestStatus[] = ['declined', 'expired', 'cancelled', 'rejected'];

export function isClosedRequestStatus(status: RequestStatus): boolean {
  return CLOSED_STATUSES.includes(status);
}

/**
 * Ce que le statut lu doit savoir de l'heure : la validité du devis envoyé, l'échéance des frais de
 * visite à payer. Absent ou null : rien en cours.
 */
export interface RequestTimeline {
  status: RequestStatus;
  sentQuoteValidUntil?: Date | null;
  pendingVisitFeeDueAt?: Date | null;
}

/**
 * Statut effectif (15.2, RV-14), seule définition utilisée pour l'affichage, le plafond des demandes
 * ouvertes et le contrôle des transitions : un devis envoyé dont la validité est passée est
 * `expired` ; des frais impayés au-delà du délai annulent la demande (R-FV-03), même avant le passage
 * de la tâche planifiée.
 */
export function effectiveRequestStatus(request: RequestTimeline, now: Date): RequestStatus {
  if (
    request.status === 'quote_sent' &&
    request.sentQuoteValidUntil &&
    isPastDeadline(request.sentQuoteValidUntil, now)
  ) {
    return 'expired';
  }
  if (
    request.status === 'awaiting_visit_fee' &&
    request.pendingVisitFeeDueAt &&
    isPastDeadline(request.pendingVisitFeeDueAt, now)
  ) {
    return 'cancelled';
  }
  return request.status;
}

/** Demandes ouvertes (R-DM-04) : `quote_sent` seulement si le devis envoyé est encore valable. */
const OPEN_STATUSES: readonly RequestStatus[] = [
  'awaiting_visit_fee',
  'visit_to_schedule',
  'visit_scheduled',
  'visit_missed',
  'visit_done',
  'quote_sent',
];

export function isOpenRequest(request: RequestTimeline, now: Date): boolean {
  return OPEN_STATUSES.includes(effectiveRequestStatus(request, now));
}

export function countOpenRequests(requests: readonly RequestTimeline[], now: Date): number {
  return requests.filter((request) => isOpenRequest(request, now)).length;
}

/**
 * R-DM-04 : `maximum` demandes ouvertes au plus par titulaire du contexte actif. Avec `openCount`
 * demandes déjà ouvertes, une nouvelle n'est admise que sous le plafond.
 */
export function assertOpenRequestLimit(openCount: number, maximum: number): void {
  if (openCount >= maximum) throw new DomainRuleError('CLEANING_TOO_MANY_OPEN_REQUESTS', { maximum });
}
