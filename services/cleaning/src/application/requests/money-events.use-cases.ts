import { type CleaningDeps } from '../deps';
import { audit, effectiveStatus, iso, money, pendingFee, saveCase } from './case-support';
import { holderOf } from './customer';
import { type Owner } from './requests.ports';
import { debitVisitFee, SYSTEM_ACTOR } from './visit-fee-money';

/** Consommateurs (inbox) des événements d'argent du lot C. */
export const PREPAID_CREDITED_CONSUMER = 'cleaning.visit_fee.wallet.prepaid.credited';
export const PAYMENT_SUCCEEDED_CONSUMER = 'cleaning.visit_fee.payment.intent.succeeded';

/** Ce que le lot C lit de wallet.prepaid.credited (versions 1 et 2 ; forObject en v2 seulement). */
export interface PrepaidCredited {
  eventId: string;
  holder: { type: 'user' | 'organization'; id: string };
  forObject?: { service: string; objectType: string; objectId: string; part: string | null } | null;
  paymentId: string | null;
}

export interface PrepaidOutcome {
  status: 'processed' | 'duplicate';
  debitedRequestIds: string[];
  leftInWallet: string[];
}

/**
 * R-WL-05, R-FV-02, RV-89, RV-93. wallet.prepaid.credited est le seul déclencheur du débit qui suit
 * un paiement direct : un crédit dont forObject désigne une demande débite aussitôt ses frais de
 * visite en attente ; si la demande n'attend plus rien (close, déjà payée), le montant reste au
 * wallet (cleaning.direct_payment.left_in_wallet). Toute recharge relance ensuite, dans l'ordre, les
 * frais de visite en attente du titulaire que le solde couvre (les séances relèvent du lot E).
 */
export class MoneyEventsUseCases {
  constructor(private readonly deps: CleaningDeps) {}

  async onPrepaidCredited(event: PrepaidCredited): Promise<PrepaidOutcome> {
    const outcome: PrepaidOutcome = { status: 'processed', debitedRequestIds: [], leftInWallet: [] };
    if (!(await this.deps.cases.markProcessed(event.eventId, PREPAID_CREDITED_CONSUMER))) {
      return { ...outcome, status: 'duplicate' };
    }
    const owner: Owner = { kind: event.holder.type, id: event.holder.id };
    const now = this.deps.clock.now();
    const target = event.forObject;
    if (target?.service === 'cleaning' && target.objectType === 'cleaning_request') {
      const record = await this.deps.cases.findCase(target.objectId);
      if (record) {
        const fee = pendingFee(record);
        if (fee && effectiveStatus(record, now) === 'awaiting_visit_fee') {
          const debited = await debitVisitFee(this.deps, record, fee, null, now);
          if (debited.outcome.status === 'succeeded') {
            outcome.debitedRequestIds.push(record.request.id);
            const payment = event.paymentId
              ? await this.deps.cases.findDirectPaymentByPaymentId(event.paymentId)
              : null;
            if (payment && payment.status === 'pending') {
              await this.deps.cases.updateDirectPayment(payment.id, {
                status: 'succeeded',
                completedAt: now,
              });
            }
          }
        } else {
          await this.leftInWallet(
            record.request.id,
            event.paymentId,
            now,
            fee ? 'request_closed' : 'already_paid',
          );
          outcome.leftInWallet.push(record.request.id);
        }
      }
    }
    // Relance des frais en attente du titulaire que le solde couvre, les plus anciens d'abord.
    for (const requestId of await this.deps.cases.awaitingFeeRequestIds(owner)) {
      if (outcome.debitedRequestIds.includes(requestId)) continue;
      const record = await this.deps.cases.findCase(requestId);
      const fee = record ? pendingFee(record) : null;
      if (!record || !fee || effectiveStatus(record, now) !== 'awaiting_visit_fee') continue;
      const balance = await this.deps.balances.available(holderOf(owner));
      if (balance < fee.amount) continue;
      const debited = await debitVisitFee(this.deps, record, fee, null, now);
      if (debited.outcome.status === 'succeeded') outcome.debitedRequestIds.push(requestId);
    }
    return outcome;
  }

  /** Montant reçu pour une demande qui n'attend plus ces frais : il reste au wallet (RV-89). */
  private async leftInWallet(
    requestId: string,
    paymentId: string | null,
    now: Date,
    cause: 'request_closed' | 'already_paid',
  ): Promise<void> {
    const record = await this.deps.cases.findCase(requestId);
    if (!record) return;
    const payments = await this.deps.cases.directPayments(requestId);
    const payment =
      (paymentId ? payments.find((item) => item.paymentRequestId === paymentId) : undefined) ??
      payments.find((item) => item.status === 'pending' || item.status === 'succeeded');
    if (!payment || payment.status === 'left_in_wallet') return;
    await this.deps.cases.updateDirectPayment(payment.id, { status: 'left_in_wallet', completedAt: now });
    await saveCase(this.deps, record, record.request.version, {
      changes: {
        events: [
          {
            type: 'cleaning.direct_payment.left_in_wallet',
            payload: {
              directPaymentId: payment.id,
              customerId: record.request.submittedBy,
              organizationId: record.request.owner.kind === 'organization' ? record.request.owner.id : null,
              objectType: 'visit_fee',
              objectId: payment.visitFeeId,
              amount: money(payment.amount),
              cause,
              leftAt: iso(now),
            },
          },
        ],
        audit: [
          audit(SYSTEM_ACTOR, 'money.left_in_wallet', 'direct_payment', payment.id, now, {
            amount: payment.amount,
          }),
        ],
      },
    });
  }

  /** payment.intent.succeeded : suivi du paiement direct seulement, jamais de débit (R-WL-05). */
  async onPaymentSucceeded(event: {
    eventId: string;
    paymentId: string;
    target?: { service: string; objectType: string } | null;
  }): Promise<'processed' | 'duplicate' | 'ignored'> {
    if (event.target?.service !== 'cleaning' || event.target.objectType !== 'cleaning_request')
      return 'ignored';
    if (!(await this.deps.cases.markProcessed(event.eventId, PAYMENT_SUCCEEDED_CONSUMER))) return 'duplicate';
    const payment = await this.deps.cases.findDirectPaymentByPaymentId(event.paymentId);
    if (payment?.status === 'pending') {
      await this.deps.cases.updateDirectPayment(payment.id, {
        status: 'succeeded',
        completedAt: this.deps.clock.now(),
      });
    }
    return 'processed';
  }
}
