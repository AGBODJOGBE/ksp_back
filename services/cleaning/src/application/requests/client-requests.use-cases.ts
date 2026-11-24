import { AppError } from '@ksp/platform';
import { assertOrganizationRight } from '../../domain/requests/organization-access';
import { cancelRequestByClient, requestReactivation } from '../../domain/requests/request-lifecycle';
import { REQUEST_STATUSES, type RequestStatus } from '../../domain/requests/request-status';
import { addHours } from '../../domain/requests/time';
import { withdrawOnRequestClosed } from '../../domain/quotes/quote';
import { cancelVisit, changeVisitSlot } from '../../domain/visits/visit';
import { type CleaningDeps } from '../deps';
import { type IdempotencyRecord, type OutboxMessage } from '../ports';
import { cleaningErrors } from '../shared/errors';
import { runIdempotent } from '../shared/idempotency';
import { page as parsePage, text } from '../shared/input';
import { caseErrors, decide } from './case-errors';
import {
  audit,
  caseParty,
  effectiveStatus,
  iso,
  liveVisit,
  money,
  ownedCase,
  pendingFee,
  saveCase,
  sentQuote,
  timelineOf,
} from './case-support';
import { type Customer, currentCustomer, holderOf } from './customer';
import { parseSlots } from './submit-request.use-case';
import { type CaseRecord, type DirectPaymentRecord, type QuoteRecord } from './requests.ports';
import { releaseVisitAgents } from './visit-agenda';
import { debitVisitFee, refundsFor, sendRefunds } from './visit-fee-money';

/** Issue d'un paiement des frais de visite (contrat PaymentOutcome). */
export interface PaymentOutcomeView {
  status: 'paid' | 'awaiting_payment';
  amount: number;
  walletTransactionId: string | null;
  paymentId: string | null;
  checkoutUrl: string | null;
}

/** Délai minimal d'une page de paiement chez payment (15 minutes). */
const MIN_PAGE_MINUTES = 15;

function act(customer: Customer, action: Parameters<typeof assertOrganizationRight>[1]): void {
  decide(() => assertOrganizationRight(customer.role, action));
}

export class ClientRequestsUseCases {
  constructor(private readonly deps: CleaningDeps) {}

  /** UC-NT-07 — Mes demandes : celles du contexte actif, les plus récentes d'abord. */
  async list(input: {
    status?: string | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
  }) {
    const customer = currentCustomer();
    if (input.status && !(REQUEST_STATUSES as readonly string[]).includes(input.status)) {
      throw cleaningErrors.invalid('status', 'invalid_type');
    }
    return this.deps.cases.listCases(
      { owner: customer.owner, ...(input.status ? { statuses: [input.status as RequestStatus] } : {}) },
      parsePage(input.limit, input.cursor),
    );
  }

  async get(requestId: string): Promise<CaseRecord> {
    return ownedCase(this.deps, currentCustomer(), requestId);
  }

  /**
   * UC-NT-05 — Payer les frais de visite (R-FV-02, R-WL-05, RV-89, RV-90, RV-95). « wallet » : débit
   * du solde. « mobile_money » : paiement direct de ce qui manque au solde ; le débit suit le crédit
   * du wallet (wallet.prepaid.credited, forObject = la demande). Si le solde couvre déjà le montant,
   * le wallet est débité, même si le client a choisi Mobile Money.
   */
  async payVisitFee(input: {
    requestId: string;
    idempotencyKey: string;
    method: string;
  }): Promise<PaymentOutcomeView> {
    const customer = currentCustomer();
    act(customer, 'pay_visit_fee');
    if (input.method !== 'wallet' && input.method !== 'mobile_money') {
      throw cleaningErrors.invalid('method', 'invalid_type');
    }
    const now = this.deps.clock.now();
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: customer.userId,
      operation: 'request.visit_fee.pay',
      key: input.idempotencyKey,
      body: { requestId: input.requestId, method: input.method },
      at: now,
      replay: async (response) => response as unknown as PaymentOutcomeView,
      run: async (stub) => {
        let record = await ownedCase(this.deps, customer, input.requestId);
        if (customer.organizationId) {
          const standing = await this.deps.cases.organizationStanding(customer.organizationId);
          if (standing.suspended) {
            throw AppError.precondition(
              'CLEANING_ORGANIZATION_SUSPENDED',
              'Cette organisation est suspendue par KSP.',
            );
          }
        }
        const status = effectiveStatus(record, now);
        const fee = pendingFee(record);
        if (!fee) throw AppError.precondition('CLEANING_NOTHING_TO_PAY', "Il n'y a rien à payer.");
        if (status !== 'awaiting_visit_fee') {
          throw AppError.precondition(
            'CLEANING_INVALID_TRANSITION',
            "Cette action n'est pas possible dans l'état actuel du dossier.",
            {
              from: status,
              to: 'visit_to_schedule',
            },
          );
        }
        const balance = await this.deps.balances.available(holderOf(record.request.owner));
        const missing = fee.amount - balance;
        let outcome: PaymentOutcomeView;
        if (missing <= 0) {
          const debited = await debitVisitFee(this.deps, record, fee, customer.userId, now);
          record = debited.record;
          if (debited.outcome.status === 'failed') throw caseErrors.insufficientBalance(fee.amount);
          outcome = {
            status: debited.outcome.status === 'succeeded' ? 'paid' : 'awaiting_payment',
            amount: fee.amount,
            walletTransactionId:
              debited.outcome.status === 'succeeded' ? debited.outcome.walletTransactionId : null,
            paymentId: null,
            checkoutUrl: null,
          };
        } else if (input.method === 'wallet') {
          throw caseErrors.insufficientBalance(missing);
        } else {
          const direct = await this.directPayment(
            customer,
            record,
            fee.id,
            fee.amount,
            missing,
            fee.dueAt,
            now,
          );
          record = direct.record;
          outcome = direct.outcome;
        }
        const fresh = await this.deps.cases.findCase(record.request.id);
        await saveCase(this.deps, fresh ?? record, (fresh ?? record).request.version, {
          changes: { events: [], audit: [], idempotency: stub({ ...outcome }) },
        });
        return outcome;
      },
    });
  }

  /**
   * Page de paiement direct (RV-90) : une page encore ouverte pour ces frais est renvoyée telle quelle
   * (même clé chez payment, même checkoutUrl) ; un paiement réussi pas encore débité répond « en
   * attente » sans nouvelle page ; sinon une nouvelle page de ce qui manque, échéance bornée à celle
   * des frais (RV-89).
   */
  private async directPayment(
    customer: Customer,
    record: CaseRecord,
    visitFeeId: string,
    amount: number,
    missing: number,
    dueAt: Date | null,
    now: Date,
  ): Promise<{ record: CaseRecord; outcome: PaymentOutcomeView }> {
    const payments = (await this.deps.cases.directPayments(record.request.id)).filter(
      (p) => p.visitFeeId === visitFeeId,
    );
    const awaiting = (
      paymentId: string | null,
      checkoutUrl: string | null,
      value: number,
    ): PaymentOutcomeView => ({
      status: 'awaiting_payment',
      amount: value,
      walletTransactionId: null,
      paymentId,
      checkoutUrl,
    });
    if (payments.some((p) => p.status === 'succeeded')) {
      return { record, outcome: awaiting(null, null, missing) };
    }
    const live = payments.find(
      (p) => p.status === 'pending' && p.amount === missing && (p.expiresAt === null || p.expiresAt > now),
    );
    const payment: DirectPaymentRecord = live ?? {
      id: this.deps.ids.next(),
      paymentRequestId: null,
      idempotencyKey: `cleaning_visit_fee_mm:${visitFeeId}:${payments.length + 1}`,
      payer: record.request.owner,
      amount: missing,
      requestId: record.request.id,
      visitFeeId,
      status: 'pending',
      expiresAt: null,
      createdAt: now,
      completedAt: null,
    };
    if (!live) {
      record = await saveCase(this.deps, record, record.request.version, {
        changes: {
          events: [],
          audit: [
            audit(customer.userId, 'money.direct_payment_requested', 'visit_fee', visitFeeId, now, {
              amount: missing,
            }),
          ],
        },
        directPayments: [payment],
      });
    }
    const usableDue = dueAt && dueAt.getTime() - now.getTime() >= MIN_PAGE_MINUTES * 60_000 ? dueAt : null;
    const page = await this.deps.directPayments.createPaymentRequest({
      idempotencyKey: payment.idempotencyKey,
      customerId: customer.userId,
      organizationId: customer.organizationId,
      amount: missing,
      target: {
        objectType: 'cleaning_request',
        objectId: record.request.id,
        part: 'visit_fee',
        reference: record.request.number,
      },
      description: `Nettoyage — frais de visite ${record.request.number} (${amount} FCFA)`,
      expiresAt: usableDue ?? (dueAt ? null : addHours(now, 72)),
    });
    await this.deps.cases.updateDirectPayment(payment.id, {
      paymentRequestId: page.paymentId,
      expiresAt: page.expiresAt,
    });
    return { record, outcome: awaiting(page.paymentId, page.checkoutUrl, missing) };
  }

  /** UC-NT-06 — Autre créneau de visite (R-VI-03) : jusqu'à 24 h avant, la visite est annulée. */
  async changeVisitSlot(input: {
    requestId: string;
    idempotencyKey: string;
    visitSlots: { start: string; end: string }[];
  }) {
    const customer = currentCustomer();
    act(customer, 'change_visit_slot');
    const slots = parseSlots(input.visitSlots);
    const now = this.deps.clock.now();
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: customer.userId,
      operation: 'request.visit_slot.change',
      key: input.idempotencyKey,
      body: { requestId: input.requestId, visitSlots: input.visitSlots },
      at: now,
      replay: async () => this.get(input.requestId),
      run: async (stub) => {
        const record = await ownedCase(this.deps, customer, input.requestId);
        const settings = await this.deps.caseSettings.caseSettings();
        const status = effectiveStatus(record, now);
        const visit = liveVisit(record);
        if (status !== 'visit_scheduled' || !visit) {
          throw AppError.precondition(
            'CLEANING_INVALID_TRANSITION',
            "Cette action n'est pas possible dans l'état actuel du dossier.",
            {
              from: status,
              to: 'visit_to_schedule',
            },
          );
        }
        const changed = decide(() =>
          changeVisitSlot({
            visit,
            requestStatus: status,
            slots,
            requestCreatedAt: record.request.createdAt,
            minLeadHours: settings.minVisitLeadHours,
            freeChangeHours: settings.freeCancellationHours,
            now,
          }),
        );
        const next: CaseRecord = {
          ...record,
          request: {
            ...record.request,
            status: changed.requestStatus,
            visitSlots: [...changed.slots],
            updatedAt: now,
          },
          visits: record.visits.map((item) => (item.id === visit.id ? { ...item, ...changed.visit } : item)),
        };
        const released = await releaseVisitAgents(this.deps, visit.id, {
          by: null,
          reason: 'slot_changed',
          at: now,
        });
        const saved = await saveCase(this.deps, next, record.request.version, {
          changes: {
            events: [
              visitCancelledEvent(
                record,
                visit.id,
                visit.scheduledStart,
                'slot_changed',
                released,
                null,
                now,
              ),
            ],
            audit: [
              audit(customer.userId, 'visit.slot_changed', 'visit', visit.id, now, {
                requestId: record.request.id,
              }),
            ],
            idempotency: stub({ requestId: record.request.id }),
          },
        });
        return saved;
      },
    });
  }

  /**
   * UC-NT-10 — Annuler une demande (partie 12, R-FV-06) avant l'acceptation. Plus de 24 h avant la
   * visite : frais remboursés au wallet ; sinon conservés. Le devis envoyé est retiré (décision du
   * responsable) ; la visite vivante est annulée et ses agents libérés (R-VI-06).
   */
  async cancel(input: {
    requestId: string;
    idempotencyKey: string;
    reasonCode?: string | undefined;
    comment?: string | undefined;
  }) {
    const customer = currentCustomer();
    act(customer, 'cancel_request');
    const comment = text(input.comment, 'comment');
    const now = this.deps.clock.now();
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: customer.userId,
      operation: 'request.cancel',
      key: input.idempotencyKey,
      body: { requestId: input.requestId, reasonCode: input.reasonCode ?? null, comment },
      at: now,
      replay: async () => this.get(input.requestId),
      run: async (stub) => {
        const record = await ownedCase(this.deps, customer, input.requestId);
        const settings = await this.deps.caseSettings.caseSettings();
        const visit = liveVisit(record);
        const outcome = decide(() =>
          cancelRequestByClient({
            request: timelineOf(record),
            fees: record.fees,
            visits: record.visits,
            reasonCode: input.reasonCode ?? null,
            freeCancellationHours: settings.freeCancellationHours,
            now,
          }),
        );
        return this.close(record, customer.userId, {
          status: 'cancelled',
          fees: outcome.fees,
          refunded: outcome.refunded,
          visitCause: outcome.visitCancelCause,
          reasonCode: outcome.reasonCode,
          reason: comment,
          visit,
          event: (refund) => ({
            type: 'cleaning.request.cancelled',
            payload: {
              ...caseParty(record.request),
              cause: 'customer',
              visitFeeRefund: refund,
              cancelledAt: iso(now),
            },
          }),
          stub: stub({ requestId: record.request.id }),
          now,
        });
      },
    });
  }

  /** Clôture commune à l'annulation et au refus par KSP (R-FV-06, R-VI-06, retrait du devis). */
  async close(
    record: CaseRecord,
    actorId: string,
    input: {
      status: 'cancelled' | 'rejected';
      fees: CaseRecord['fees'];
      refunded: number;
      visitCause: 'request_cancelled' | 'request_rejected' | null;
      reasonCode: string | null;
      reason: string | null;
      visit: ReturnType<typeof liveVisit>;
      event: (refund: { amount: number; currency: 'XOF' } | null) => OutboxMessage;
      stub?: IdempotencyRecord;
      now: Date;
    },
  ): Promise<CaseRecord> {
    const { now } = input;
    const withdrawn = withdrawOnRequestClosed(sentQuote(record), input.status, actorId, now);
    const visit = input.visit;
    const cancelledVisit = visit && input.visitCause ? cancelVisit(visit, input.visitCause, now) : null;
    const next: CaseRecord = {
      ...record,
      request: {
        ...record.request,
        status: input.status,
        closingReason: input.reason,
        closingReasonCode: input.reasonCode,
        closedAt: now,
        updatedAt: now,
      },
      fees: input.fees,
      visits: record.visits.map((item) =>
        cancelledVisit && item.id === cancelledVisit.id ? { ...item, ...cancelledVisit } : item,
      ),
      quotes: record.quotes.map((quote): QuoteRecord =>
        withdrawn && quote.id === withdrawn.id ? { ...quote, ...withdrawn } : quote,
      ),
    };
    const refunds = await refundsFor(this.deps, record, record.fees, input.fees, actorId, now);
    const refund = input.refunded > 0 ? money(input.refunded) : null;
    const released =
      cancelledVisit && visit
        ? await releaseVisitAgents(this.deps, visit.id, {
            by: null,
            reason: input.visitCause ?? 'closed',
            at: now,
          })
        : [];
    const events: OutboxMessage[] = [input.event(refund)];
    if (cancelledVisit && visit && input.visitCause) {
      events.push(
        visitCancelledEvent(record, visit.id, visit.scheduledStart, input.visitCause, released, null, now),
      );
    }
    if (withdrawn) {
      events.push({
        type: 'cleaning.quote.withdrawn',
        payload: {
          ...caseParty(record.request),
          quoteId: withdrawn.id,
          version: withdrawn.version,
          withdrawnAt: iso(now),
        },
      });
    }
    const saved = await saveCase(this.deps, next, record.request.version, {
      changes: {
        events,
        audit: [
          audit(
            actorId,
            input.status === 'cancelled' ? 'request.cancelled' : 'request.rejected',
            'request',
            record.request.id,
            now,
            {
              refunded: input.refunded,
              ...(withdrawn ? { withdrawnQuoteId: withdrawn.id } : {}),
            },
          ),
        ],
        ...(input.stub ? { idempotency: input.stub } : {}),
      },
      walletOperations: refunds,
    });
    await sendRefunds(this.deps, refunds, now);
    return saved;
  }

  /** UC-NT-08 — Demander la réactivation d'un devis expiré (R-AC-04), rejouable sans effet. */
  async requestReactivation(input: { requestId: string; idempotencyKey: string }) {
    const customer = currentCustomer();
    act(customer, 'request_reactivation');
    const now = this.deps.clock.now();
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: customer.userId,
      operation: 'request.reactivation.request',
      key: input.idempotencyKey,
      body: { requestId: input.requestId },
      at: now,
      replay: async () => this.get(input.requestId),
      run: async (stub) => {
        const record = await ownedCase(this.deps, customer, input.requestId);
        const current = record.reactivations.find((item) => item.status === 'pending') ?? null;
        const reactivation = decide(() =>
          requestReactivation(timelineOf(record), current, customer.userId, now),
        );
        if (reactivation === current) {
          return saveCase(this.deps, record, record.request.version, {
            changes: { events: [], audit: [], idempotency: stub({ requestId: record.request.id }) },
          });
        }
        const next: CaseRecord = {
          ...record,
          request: { ...record.request, updatedAt: now },
          reactivations: [
            ...record.reactivations,
            { ...reactivation, id: this.deps.ids.next(), reason: null },
          ],
        };
        return saveCase(this.deps, next, record.request.version, {
          changes: {
            events: [
              {
                type: 'cleaning.request.reactivation_requested',
                payload: {
                  ...caseParty(record.request),
                  communeKey: record.request.communeKey,
                  requestedAt: iso(now),
                },
              },
            ],
            audit: [
              audit(customer.userId, 'request.reactivation_requested', 'request', record.request.id, now),
            ],
            idempotency: stub({ requestId: record.request.id }),
          },
        });
      },
    });
  }
}

export function visitCancelledEvent(
  record: CaseRecord,
  visitId: string,
  scheduledAt: Date,
  cause: 'request_cancelled' | 'request_rejected' | 'slot_changed' | 'ksp' | 'agent_no_show',
  releasedAgentIds: string[],
  refund: number | null,
  now: Date,
): OutboxMessage {
  return {
    type: 'cleaning.visit.cancelled',
    payload: {
      ...caseParty(record.request),
      visitId,
      communeKey: record.request.communeKey,
      releasedAgentIds,
      scheduledAt: iso(scheduledAt),
      cause,
      visitFeeRefund: refund !== null && refund > 0 ? money(refund) : null,
      cancelledAt: iso(now),
    },
  };
}
