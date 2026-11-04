import { isTerminalMission, type Mission, type MissionStatus, remainingToSchedule } from './mission';
import { remainingDue } from './payment';
import { findProposedSlot, isQuoteExpired } from './quote';
import {
  canTransitionRequest,
  effectiveRequestStatus,
  isOpenRequest,
  type QuoteRequest,
  type RequestStatus,
} from './quote-request';

/**
 * Opérations sur un groupe de demandes (ADR-035) : visite commune, refus ou annulation du groupe,
 * devis envoyés ensemble, acceptation commune, planification commune. Chaque demande garde son
 * circuit (ADR-034) : une opération de groupe applique à chacune la règle de la demande seule, et
 * laisse de côté, avec une raison, celles qui ne s'y prêtent pas (jamais d'erreur pour l'une d'elles).
 */
export type SkipReason =
  | 'not_open'
  | 'transition_not_allowed'
  | 'excluded'
  | 'own_visit'
  | 'visit_completed'
  | 'no_quote'
  | 'quote_expired'
  | 'slot_not_proposed';

export interface SkippedRequest {
  requestId: string;
  status: RequestStatus;
  reason: SkipReason;
}

export interface Selection {
  selected: QuoteRequest[];
  skipped: SkippedRequest[];
}

/** Un groupe est ouvert tant qu'au moins une de ses demandes l'est : il compte pour 1 dans le plafond. */
export function isOpenGroup(requests: readonly Pick<QuoteRequest, 'status' | 'quote'>[], now: Date): boolean {
  return requests.some((request) => isOpenRequest(request, now));
}

/** Nombre d'envois ouverts : chaque demande seule et chaque groupe ouvert comptent pour 1. */
export function openSubmissions(
  requests: readonly Pick<QuoteRequest, 'status' | 'quote' | 'groupId'>[],
  now: Date,
): number {
  const groups = new Set<string>();
  let single = 0;
  for (const request of requests) {
    if (!isOpenRequest(request, now)) continue;
    if (request.groupId) groups.add(request.groupId);
    else single += 1;
  }
  return single + groups.size;
}

function skip(request: QuoteRequest, reason: SkipReason, now: Date): SkippedRequest {
  return { requestId: request.id, status: effectiveRequestStatus(request, now), reason };
}

/**
 * Demandes qui peuvent passer à l'état `to` (règle de la demande seule, à partir de l'état affiché) :
 * une demande close ou acceptée est laissée de côté (`not_open`), une demande ouverte dans un état
 * incompatible aussi (`transition_not_allowed`, par exemple un refus après l'envoi du devis).
 */
export function selectByTransition(
  requests: readonly QuoteRequest[],
  to: RequestStatus,
  now: Date,
): Selection {
  const selection: Selection = { selected: [], skipped: [] };
  for (const request of requests) {
    const from = effectiveRequestStatus(request, now);
    if (canTransitionRequest(from, to)) selection.selected.push(request);
    else
      selection.skipped.push(
        skip(request, isOpenRequest(request, now) ? 'transition_not_allowed' : 'not_open', now),
      );
  }
  return selection;
}

/** Visite commune en cours (planifiée) du groupe, null s'il n'y en a pas. */
export function currentGroupVisitId(requests: readonly QuoteRequest[]): string | null {
  const visit = requests.find(
    (request) => request.visit?.status === 'scheduled' && request.visit.groupVisitId,
  );
  return visit?.visit?.groupVisitId ?? null;
}

export interface GroupVisitPlan extends Selection {
  /** Demandes détachées par exclusion : elles gardent leur visite, qui devient la leur. */
  detached: QuoteRequest[];
}

/**
 * Demandes concernées par la visite commune : ouvertes, dans un état qui admet une visite, non
 * exclues, sans visite à elles (sinon `own_visit`) ni visite déjà réalisée (`visit_completed`) ; une
 * demande de la visite commune en cours est replanifiée avec les autres. Une demande exclue qui
 * faisait partie de la visite commune en est détachée.
 */
export function planGroupVisit(
  requests: readonly QuoteRequest[],
  excludedIds: ReadonlySet<string>,
  now: Date,
): GroupVisitPlan {
  const current = currentGroupVisitId(requests);
  const { selected, skipped } = selectByTransition(requests, 'visit_scheduled', now);
  const plan: GroupVisitPlan = { selected: [], skipped, detached: [] };
  for (const request of selected) {
    const visit = request.visit;
    const inGroupVisit =
      visit?.status === 'scheduled' && Boolean(visit.groupVisitId) && visit.groupVisitId === current;
    if (excludedIds.has(request.id)) {
      if (inGroupVisit) plan.detached.push(request);
      plan.skipped.push(skip(request, 'excluded', now));
    } else if (visit?.status === 'scheduled' && !inGroupVisit) {
      plan.skipped.push(skip(request, 'own_visit', now));
    } else if (visit?.status === 'completed') {
      plan.skipped.push(skip(request, 'visit_completed', now));
    } else {
      plan.selected.push(request);
    }
  }
  return plan;
}

/** Demandes dont la visite commune en cours est encore planifiée (compte rendu commun). */
export function groupVisitMembers(requests: readonly QuoteRequest[]): QuoteRequest[] {
  const current = currentGroupVisitId(requests);
  if (!current) return [];
  return requests.filter(
    (request) => request.visit?.status === 'scheduled' && request.visit.groupVisitId === current,
  );
}

/**
 * Devis à accepter ensemble : devis envoyés, encore valables, qui proposent le créneau choisi ; les
 * autres demandes sont laissées de côté avec leur raison.
 */
export function selectAcceptable(requests: readonly QuoteRequest[], slotStart: Date, now: Date): Selection {
  const selection: Selection = { selected: [], skipped: [] };
  for (const request of requests) {
    const status = effectiveRequestStatus(request, now);
    if (status === 'expired') selection.skipped.push(skip(request, 'quote_expired', now));
    else if (status !== 'quote_sent') {
      selection.skipped.push(skip(request, isOpenRequest(request, now) ? 'no_quote' : 'not_open', now));
    } else if (!request.quote || isQuoteExpired(request.quote, now)) {
      selection.skipped.push(skip(request, 'quote_expired', now));
    } else if (!findProposedSlot(request.quote, slotStart)) {
      selection.skipped.push(skip(request, 'slot_not_proposed', now));
    } else selection.selected.push(request);
  }
  return selection;
}

export type MissionSkipReason = 'terminated' | 'suspended' | 'no_intervention_left';

export interface SkippedMission {
  missionId: string;
  status: MissionStatus;
  reason: MissionSkipReason;
}

/** Missions du groupe à planifier ensemble : ni terminées, ni suspendues, avec un passage à planifier. */
export function selectSchedulable(missions: readonly Mission[]): {
  selected: Mission[];
  skipped: SkippedMission[];
} {
  const selected: Mission[] = [];
  const skipped: SkippedMission[] = [];
  for (const mission of missions) {
    const base = { missionId: mission.id, status: mission.status };
    if (isTerminalMission(mission.status)) skipped.push({ ...base, reason: 'terminated' });
    else if (mission.suspension) skipped.push({ ...base, reason: 'suspended' });
    else if (remainingToSchedule(mission) === 0) skipped.push({ ...base, reason: 'no_intervention_left' });
    else selected.push(mission);
  }
  return { selected, skipped };
}

/**
 * Total des devis envoyés du groupe (entiers XOF) : devis en vigueur des demandes au devis envoyé
 * encore valable ou accepté ; null si aucune n'en a.
 */
export function groupQuotesTotal(requests: readonly QuoteRequest[], now: Date): number | null {
  const quoted = requests.filter(
    (request) => request.quote && ['quote_sent', 'accepted'].includes(effectiveRequestStatus(request, now)),
  );
  return quoted.length ? quoted.reduce((sum, request) => sum + request.quote!.total, 0) : null;
}

/**
 * Reste dû des missions du groupe, hors missions annulées (entiers XOF) ; null sans mission, ou pour
 * une entreprise (ses missions se règlent par les factures mensuelles de billing).
 */
export function groupRemainingDue(missions: readonly Mission[]): number | null {
  const counted = missions.filter((mission) => mission.status !== 'cancelled');
  if (!counted.length || counted.some((mission) => mission.organizationId)) return null;
  return counted.reduce((sum, mission) => sum + remainingDue(mission.payment), 0);
}
