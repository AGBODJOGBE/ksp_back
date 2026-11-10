import { type CleaningQuoteRef } from '@ksp/contracts';
import { CURRENCY } from '../../domain/money';
import { type QuoteRequest } from '../../domain/quote-request';
import {
  isQuoteToExpire,
  isQuoteToRemind,
  isStaleVisit,
  reminderHorizon,
  requestBatches,
} from '../../domain/request-deadlines';
import { type CleaningDeps } from '../deps';
import { type AuditEntry, type Changes, type OutboxMessage } from '../ports';
import { eventSubject } from '../shared/event-subject';
import { SYSTEM_ACTOR } from '../standing/standing.use-cases';

/** Demandes lues par passage de la tâche, pour chaque échéance : le reste attend le passage suivant. */
const SCAN_LIMIT = 200;

export interface DeadlinesReport {
  expired: number;
  reminded: number;
  visitsCancelled: number;
  /** Lots non enregistrés (écriture concurrente) : repris au passage suivant. */
  failed: number;
}

function systemAudit(
  action: string,
  request: QuoteRequest,
  at: Date,
  details?: Record<string, unknown>,
): AuditEntry {
  return {
    actorId: SYSTEM_ACTOR,
    action,
    entityType: 'quote_request',
    entityId: request.id,
    at,
    ...(details ? { details } : {}),
  };
}

/**
 * Échéances des demandes (ADR-053), par la tâche planifiée de cleaning. Chaque écriture se fait avec
 * le contrôle de version (ou un marquage conditionnel pour les rappels) dans la même transaction que
 * ses événements : rejouer la tâche, ou la lancer sur plusieurs instances, ne publie rien deux fois.
 * 1. devis expirés → demande « expirée », cleaning.quote.expired (un message par client et par groupe) ;
 * 2. rappel N jours avant l'expiration (réglage, 0 = désactivé), une fois par devis ;
 * 3. visites planifiées de demandes closes → annulées, cleaning.visit.cancelled pour une visite à venir.
 */
export class WatchRequestDeadlinesUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(): Promise<DeadlinesReport> {
    const now = this.deps.clock.now();
    const report: DeadlinesReport = { expired: 0, reminded: 0, visitsCancelled: 0, failed: 0 };
    await this.expireQuotes(now, report);
    await this.remindQuotes(now, report);
    await this.cancelStaleVisits(now, report);
    return report;
  }

  private async expireQuotes(now: Date, report: DeadlinesReport): Promise<void> {
    const due = (await this.deps.requests.listQuotesToExpire(now, SCAN_LIMIT)).filter((request) =>
      isQuoteToExpire(request, now),
    );
    for (const batch of requestBatches(due)) {
      const expired = batch.map((request): QuoteRequest => ({
        ...request,
        status: 'expired',
        updatedAt: now,
      }));
      const event = await this.quoteEvent(batch, (quotes, base) => ({
        type: 'cleaning.quote.expired',
        payload: { ...base, quotes, expiredAt: now.toISOString() },
      }));
      const outcome = await this.deps.requests.saveGroup({
        requests: expired,
        changes: {
          events: [event],
          audit: batch.map((request) => systemAudit('quote.expired', request, now)),
        },
      });
      if (outcome === 'saved') report.expired += batch.length;
      else report.failed += 1;
    }
  }

  private async remindQuotes(now: Date, report: DeadlinesReport): Promise<void> {
    const { quoteExpiryReminderDays: days } = await this.deps.catalog.getSettings();
    if (days <= 0) return;
    const due = (
      await this.deps.requests.listQuotesToRemind(now, reminderHorizon(now, days), SCAN_LIMIT)
    ).filter((request) => isQuoteToRemind(request, now, days));
    for (const batch of requestBatches(due)) {
      // Noms des prestations lus avant l'écriture : l'événement ne cite que les devis marqués.
      const refs = await this.quoteRefs(batch);
      const reminded = await this.deps.requests.recordQuoteReminders(
        batch.map((request) => ({ requestId: request.id, quoteId: request.quote!.id })),
        (ids) => reminderChanges(batch, refs, ids, days, now),
      );
      report.reminded += reminded.length;
    }
  }

  private async cancelStaleVisits(now: Date, report: DeadlinesReport): Promise<void> {
    const stale = (await this.deps.requests.listStaleVisits(SCAN_LIMIT)).filter(isStaleVisit);
    const handled = new Set<string>();
    for (const request of stale) {
      const visit = request.visit!;
      const key = visit.groupVisitId ?? visit.id;
      if (handled.has(key)) continue;
      handled.add(key);
      // Visite commune : annulée seulement quand aucune demande ouverte n'en a encore besoin ; sinon
      // les demandes closes en sont simplement retirées, sans message.
      const members =
        visit.groupVisitId && request.groupId ? await this.groupVisitMembers(request, key) : [request];
      const closing = members.filter(isStaleVisit);
      const visitEnds = closing.length === members.length;
      const cancelled = closing.map((member): QuoteRequest => ({
        ...member,
        visit: { ...member.visit!, status: 'cancelled' },
        updatedAt: now,
      }));
      const events: OutboxMessage[] =
        visitEnds && visit.scheduledAt > now ? [await this.visitCancelled(key, closing, now)] : [];
      const outcome = await this.deps.requests.saveGroup({
        requests: cancelled,
        changes: {
          events,
          audit: closing.map((member) =>
            systemAudit('visit.cancelled', member, now, { visitId: member.visit!.id, status: member.status }),
          ),
        },
      });
      if (outcome === 'saved') report.visitsCancelled += closing.length;
      else report.failed += 1;
    }
  }

  /** Demandes du groupe qui partagent encore cette visite commune planifiée. */
  private async groupVisitMembers(request: QuoteRequest, groupVisitId: string): Promise<QuoteRequest[]> {
    const view = await this.deps.requests.findGroup(request.groupId!);
    const members = (view?.requests ?? []).filter(
      (member) => member.visit?.groupVisitId === groupVisitId && member.visit.status === 'scheduled',
    );
    return members.length ? members : [request];
  }

  private async visitCancelled(visitId: string, requests: QuoteRequest[], now: Date): Promise<OutboxMessage> {
    const first = requests[0]!;
    const subjects = await Promise.all(requests.map((request) => eventSubject(this.deps, request)));
    return {
      type: 'cleaning.visit.cancelled',
      payload: {
        visitId,
        requestIds: requests.map((request) => request.id),
        customerId: first.customerId,
        agentId: first.visit!.agentId,
        scheduledAt: first.visit!.scheduledAt.toISOString(),
        outcome: first.status as 'rejected' | 'cancelled' | 'declined' | 'expired',
        cancelledAt: now.toISOString(),
        ...(first.groupId ? { groupId: first.groupId } : {}),
        requests: requests.map((request, index) => ({
          requestId: request.id,
          serviceCode: request.serviceCode,
          ...(subjects[index]!.serviceName ? { serviceName: subjects[index]!.serviceName } : {}),
        })),
      },
    };
  }

  private async quoteEvent(
    batch: QuoteRequest[],
    build: (quotes: CleaningQuoteRef[], base: ReturnType<typeof batchBase>) => OutboxMessage,
  ): Promise<OutboxMessage> {
    return build(await this.quoteRefs(batch), batchBase(batch[0]!));
  }

  private async quoteRefs(batch: QuoteRequest[]): Promise<CleaningQuoteRef[]> {
    const subjects = await Promise.all(batch.map((request) => eventSubject(this.deps, request)));
    return batch.map((request, index) => quoteRef(request, subjects[index]!.serviceName));
  }
}

/** Rappel des devis effectivement marqués (aucun : rien n'est écrit). */
function reminderChanges(
  batch: QuoteRequest[],
  refs: CleaningQuoteRef[],
  markedIds: readonly string[],
  days: number,
  now: Date,
): Changes {
  const marked = batch.filter((request) => markedIds.includes(request.id));
  if (!marked.length) return { events: [], audit: [] };
  const quotes = refs.filter((ref) => markedIds.includes(ref.requestId));
  const validUntil = new Date(Math.min(...marked.map((request) => request.quote!.validUntil.getTime())));
  return {
    events: [
      {
        type: 'cleaning.quote.expiry_reminded',
        payload: {
          ...batchBase(marked[0]!),
          quotes,
          validUntil: validUntil.toISOString(),
          reminderDays: days,
        },
      },
    ],
    audit: marked.map((request) => systemAudit('quote.expiry_reminded', request, now)),
  };
}

/** Client, organisation et groupe d'un lot (communs à ses demandes). */
function batchBase(request: QuoteRequest) {
  return {
    customerId: request.customerId,
    organizationId: request.organizationId,
    ...(request.groupId ? { groupId: request.groupId } : {}),
  };
}

function quoteRef(request: QuoteRequest, serviceName: string | undefined): CleaningQuoteRef {
  const quote = request.quote!;
  return {
    requestId: request.id,
    quoteId: quote.id,
    serviceCode: request.serviceCode,
    ...(serviceName ? { serviceName } : {}),
    total: { amount: quote.total, currency: CURRENCY },
    validUntil: quote.validUntil.toISOString(),
  };
}
