import { AppError } from '@ksp/platform';
import {
  amountMatches,
  applyProviderStatus,
  CURRENCY,
  expire,
  flagAmountMismatch,
  ONLINE_METHOD,
  type PaymentIntent,
  providerDescription,
  supersede,
  type Transition,
} from '../domain/payment-intent';
import {
  type NotificationOutcome,
  type OutboxMessage,
  type PaymentDeps,
  type ProviderTransaction,
} from './ports';
import { PaymentErrors } from './shared/errors';

const MAX_ATTEMPTS = 3;

/**
 * Événements d'un changement d'état : réussite ou échec, identifiants et montants seulement. Un
 * montant approuvé différent n'en publie aucun : rien ne doit être enregistré chez cleaning ni billing.
 */
export function transitionEvents(transition: NonNullable<Transition>): OutboxMessage[] {
  if (transition.kind === 'amount_mismatch') return [];
  const intent = transition.intent;
  const ref = {
    paymentId: intent.id,
    subjectType: intent.subject.type,
    subjectId: intent.subject.id,
    part: intent.subject.part,
    subjectReference: intent.subject.reference,
    customerId: intent.customerId,
    organizationId: intent.organizationId,
    amount: { amount: intent.amount, currency: CURRENCY as 'XOF' },
    provider: intent.provider,
  };
  if (transition.kind === 'succeeded') {
    return [
      {
        type: 'payment.intent.succeeded',
        payload: {
          ...ref,
          method: ONLINE_METHOD,
          providerReference: intent.providerReference,
          succeededAt: (intent.completedAt ?? intent.updatedAt).toISOString(),
        },
      },
    ];
  }
  return [
    {
      type: 'payment.intent.failed',
      payload: {
        ...ref,
        status: intent.status as 'failed' | 'cancelled' | 'expired',
        failedAt: (intent.completedAt ?? intent.updatedAt).toISOString(),
      },
    },
  ];
}

/**
 * Aligne un paiement sur le prestataire, seul juge de son statut (ADR-031). Un changement d'état et
 * ses événements sont écrits ensemble (outbox), sous contrôle de version : deux confirmations
 * simultanées (notification et retour du client) ne publient qu'un seul événement.
 */
export class PaymentSync {
  constructor(private readonly deps: PaymentDeps) {}

  /**
   * Applique la transaction relue chez le prestataire. Elle doit être celle du paiement (même
   * identifiant, métadonnée `payment_id` égale au paiement) : sinon, elle est ignorée et signalée.
   * Approuvée pour un autre montant ou une autre devise : `amount_mismatch`, signalé, jamais expiré.
   */
  async apply(
    intent: PaymentIntent,
    transaction: ProviderTransaction,
  ): Promise<{ intent: PaymentIntent; outcome: NotificationOutcome }> {
    if (transaction.transactionId !== intent.providerTransactionId || transaction.paymentId !== intent.id) {
      this.deps.alerts.transactionMismatch({
        paymentId: intent.id,
        expectedTransactionId: intent.providerTransactionId,
        receivedTransactionId: transaction.transactionId,
        receivedPaymentId: transaction.paymentId,
      });
      return { intent, outcome: 'transaction_mismatch' };
    }
    let current = intent;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const now = this.deps.clock.now();
      const wrongAmount =
        transaction.status === 'approved' &&
        !amountMatches(current, transaction.amount, transaction.currency);
      const transition = wrongAmount
        ? flagAmountMismatch(current, now)
        : applyProviderStatus(current, transaction.status, now);
      const next: PaymentIntent = {
        ...(transition ? transition.intent : current),
        providerReference: current.providerReference ?? transaction.reference,
        lastCheckedAt: now,
      };
      const events = transition ? transitionEvents({ ...transition, intent: next }) : [];
      if (await this.deps.payments.save(next, events)) {
        if (wrongAmount) {
          this.deps.alerts.amountMismatch({
            paymentId: current.id,
            transactionId: transaction.transactionId,
            expectedAmount: current.amount,
            approvedAmount: transaction.amount,
            currency: transaction.currency,
          });
        }
        const outcome: NotificationOutcome = wrongAmount
          ? 'amount_mismatch'
          : transition
            ? 'applied'
            : 'no_change';
        return { intent: { ...next, version: next.version + 1 }, outcome };
      }
      const reloaded = await this.deps.payments.findById(current.id);
      if (!reloaded) throw PaymentErrors.notFound();
      current = reloaded;
    }
    throw PaymentErrors.concurrentUpdate();
  }

  /** Relit la transaction chez le prestataire puis l'applique. */
  async refresh(intent: PaymentIntent): Promise<{ intent: PaymentIntent; outcome: NotificationOutcome }> {
    if (!intent.providerTransactionId) return { intent, outcome: 'no_change' };
    const transaction = await this.deps.provider.getTransaction(intent.providerTransactionId);
    return this.apply(intent, transaction);
  }

  /**
   * Paiement en attente au-delà de son délai : sa transaction est annulée chez le prestataire si son
   * API le permet, puis il est expiré (payment.intent.failed). Une réussite qui arriverait malgré
   * tout est rattrapée par le rapprochement (réussite tardive).
   */
  async expire(intent: PaymentIntent): Promise<PaymentIntent> {
    if (!expire(intent, this.deps.clock.now())) return intent;
    await this.cancelAtProvider(intent);
    return this.close(intent, expire(intent, this.deps.clock.now()));
  }

  /** Paiement en attente remplacé par un nouveau pour le même objet : page annulée, paiement annulé. */
  async supersede(intent: PaymentIntent): Promise<PaymentIntent> {
    if (intent.status !== 'pending') return intent;
    await this.cancelAtProvider(intent);
    return this.close(intent, supersede(intent, this.deps.clock.now()));
  }

  private async close(intent: PaymentIntent, transition: Transition): Promise<PaymentIntent> {
    if (!transition) return intent;
    const saved = await this.deps.payments.save(transition.intent, transitionEvents(transition));
    return saved ? { ...transition.intent, version: transition.intent.version + 1 } : intent;
  }

  /** Annulation au mieux chez le prestataire : une panne n'empêche pas la clôture locale. */
  private async cancelAtProvider(intent: PaymentIntent): Promise<void> {
    if (!intent.providerTransactionId || !this.deps.provider.cancelTransaction) return;
    try {
      await this.deps.provider.cancelTransaction(intent.providerTransactionId);
    } catch {
      // La réussite tardive éventuelle reste rattrapée par le rapprochement.
    }
  }

  /**
   * Crée la transaction et sa page de paiement chez le prestataire. Panne du prestataire : le
   * paiement reste en attente sans page ; le client renvoie la création avec la même clé.
   */
  async startCheckout(intent: PaymentIntent): Promise<PaymentIntent> {
    let checkout;
    try {
      checkout = await this.deps.provider.createCheckout({
        paymentId: intent.id,
        amount: intent.amount,
        currency: 'XOF',
        description: providerDescription(intent.subject),
        returnUrl: `${this.deps.settings.returnUrl.replace(/\/+$/, '')}/${intent.id}`,
      });
    } catch (error) {
      if (error instanceof AppError && error.kind !== 'UNAVAILABLE' && error.kind !== 'DEADLINE_EXCEEDED') {
        throw error;
      }
      throw PaymentErrors.providerUnavailable();
    }
    const now = this.deps.clock.now();
    const next: PaymentIntent = {
      ...intent,
      providerTransactionId: checkout.transactionId,
      providerReference: checkout.reference,
      checkoutUrl: checkout.checkoutUrl,
      updatedAt: now,
    };
    if (await this.deps.payments.save(next, [])) return { ...next, version: next.version + 1 };
    // Une autre requête (même clé) a enregistré sa propre page : c'est elle qui fait foi.
    const reloaded = await this.deps.payments.findById(intent.id);
    if (!reloaded) throw PaymentErrors.notFound();
    return reloaded;
  }
}
