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
  type SubjectType,
  SUBJECT_TYPES,
  supersede,
  type Transition,
} from '../domain/payment-intent';

const isAccountSubject = (type: string): type is SubjectType =>
  (SUBJECT_TYPES as readonly string[]).includes(type);
import {
  type NotificationOutcome,
  type OutboxMessage,
  type PaymentDeps,
  type ProviderTransaction,
} from './ports';
import { PaymentErrors } from './shared/errors';

const MAX_ATTEMPTS = 3;
const MINUTE_MS = 60_000;

/**
 * Événements d'un changement d'état : réussite ou échec, identifiants et montants seulement. Un
 * montant approuvé différent n'en publie aucun : rien ne doit être enregistré chez cleaning ni billing.
 *
 * Paiement par lien (ADR-040) : la réussite publie `payment.link.paid` (et jamais
 * `payment.intent.succeeded`, réservé aux paiements par compte et écouté par cleaning, billing et
 * notification) ; un échec ne publie rien (le payeur réessaie depuis la page du lien).
 */
export function transitionEvents(transition: NonNullable<Transition>): OutboxMessage[] {
  if (transition.kind === 'amount_mismatch') return [];
  const intent = transition.intent;
  if (intent.paymentLinkId !== null) {
    if (transition.kind !== 'succeeded') return [];
    return [
      {
        type: 'payment.link.paid',
        payload: {
          paymentLinkId: intent.paymentLinkId,
          paymentId: intent.id,
          subjectType: intent.subject.type,
          subjectId: intent.subject.id,
          reference: intent.subject.reference ?? '',
          amount: { amount: intent.amount, currency: CURRENCY as 'XOF' },
          method: ONLINE_METHOD,
          provider: intent.provider,
          providerReference: intent.providerReference,
          paidAt: (intent.completedAt ?? intent.updatedAt).toISOString(),
        },
      },
    ];
  }
  if (intent.customerId === null || !isAccountSubject(intent.subject.type)) {
    throw new Error(`Paiement ${intent.id} sans payeur ni lien : état impossible.`);
  }
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
   * Échéance d'une nouvelle page (ADR-048) : le délai court si le prestataire sait l'annuler, sinon sa
   * validité chez lui. Tant qu'elle peut être payée, le paiement reste en attente et la page est
   * réutilisée : jamais une seconde page payable pour le même objet.
   */
  expiry(now: Date): Date {
    const { intentTtlMinutes, checkoutValidityMinutes } = this.deps.settings;
    const minutes = this.deps.provider.cancelTransaction
      ? intentTtlMinutes
      : Math.max(intentTtlMinutes, checkoutValidityMinutes);
    return new Date(now.getTime() + minutes * MINUTE_MS);
  }

  /**
   * Paiement en attente au-delà de son délai : sa page est annulée chez le prestataire, puis il est
   * expiré (payment.intent.failed). Annulation impossible (non prévue par le prestataire, refusée ou
   * en panne) : il reste en attente tant que la page peut être payée (validité), puis il est clos avec
   * une alerte ; une réussite qui arriverait malgré tout est rattrapée (réussite tardive).
   */
  async expire(intent: PaymentIntent): Promise<PaymentIntent> {
    if (!expire(intent, this.deps.clock.now())) return intent;
    if (!(await this.closeAtProvider(intent, 'expired'))) return intent;
    return this.close(intent, expire(intent, this.deps.clock.now()));
  }

  /**
   * Paiement en attente remplacé (montant dû changé, page jamais obtenue) : page annulée chez le
   * prestataire, paiement annulé. Page impossible à annuler et encore valide : rien ne change, le
   * paiement reste en attente (l'appelant refuse d'en ouvrir un autre, ADR-048).
   */
  async supersede(intent: PaymentIntent): Promise<PaymentIntent> {
    if (intent.status !== 'pending') return intent;
    if (!(await this.closeAtProvider(intent, 'superseded'))) return intent;
    return this.close(intent, supersede(intent, this.deps.clock.now()));
  }

  /**
   * Paiement en attente relu chez le prestataire (au mieux), puis expiré au-delà de son délai :
   * son état réel avant de décider d'ouvrir une autre page pour l'objet.
   */
  async current(intent: PaymentIntent): Promise<PaymentIntent> {
    let current = intent;
    try {
      if (current.status === 'pending' && current.providerTransactionId) {
        current = (await this.refresh(current)).intent;
      }
    } catch {
      // Prestataire injoignable : dernier état connu.
    }
    return current.status === 'pending' ? this.expire(current) : current;
  }

  private async close(intent: PaymentIntent, transition: Transition): Promise<PaymentIntent> {
    if (!transition) return intent;
    const saved = await this.deps.payments.save(transition.intent, transitionEvents(transition));
    return saved ? { ...transition.intent, version: transition.intent.version + 1 } : intent;
  }

  /**
   * La page peut-elle être close ? Oui sans transaction (aucune page), si le prestataire confirme
   * son annulation, ou au-delà de sa validité (avec une alerte : elle n'a pas été annulée). Non
   * sinon : elle peut encore être payée.
   */
  private async closeAtProvider(intent: PaymentIntent, reason: 'expired' | 'superseded'): Promise<boolean> {
    const transactionId = intent.providerTransactionId;
    if (!transactionId) return true;
    const cancel = this.deps.provider.cancelTransaction?.bind(this.deps.provider);
    if (cancel) {
      try {
        if (await cancel(transactionId)) return true;
      } catch {
        // Panne : la validité tranche.
      }
    }
    const validUntil = intent.createdAt.getTime() + this.deps.settings.checkoutValidityMinutes * MINUTE_MS;
    if (this.deps.clock.now().getTime() < validUntil) return false;
    this.deps.alerts.checkoutClosedUnconfirmed({ paymentId: intent.id, transactionId, reason });
    return true;
  }

  /**
   * Crée la transaction et sa page de paiement chez le prestataire. Panne du prestataire : le
   * paiement reste en attente sans page ; le client renvoie la création avec la même clé. Retour du
   * payeur : `returnUrl` (page publique d'un lien), sinon <PAYMENT_RETURN_URL>/<id du paiement>.
   */
  async startCheckout(intent: PaymentIntent, returnUrl?: string): Promise<PaymentIntent> {
    let checkout;
    try {
      checkout = await this.deps.provider.createCheckout({
        paymentId: intent.id,
        amount: intent.amount,
        currency: 'XOF',
        description: providerDescription(intent.subject),
        returnUrl: returnUrl ?? `${this.deps.settings.returnUrl.replace(/\/+$/, '')}/${intent.id}`,
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
