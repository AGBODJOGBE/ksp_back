import { MAX_AMOUNT } from '../domain/payment-link';
import { type PaymentIntent, type PaymentSubject, sameSubject } from '../domain/payment-intent';
import { type PaymentDeps } from './ports';
import { currentPayer, requireCaller } from './shared/access';
import { PaymentErrors } from './shared/errors';
import { IDEMPOTENCY_KEY, requireUuid, requireXof } from './shared/validation';
import { PaymentSync } from './sync';

/** Seul wallet demande une recharge : il en contrôle les limites (ADR-046). */
const TOP_UP_CALLERS = ['wallet'];

/**
 * Paiement de recharge relu par wallet avant tout crédit (ADR-048) : statut, titulaire (objet
 * `wallet_top_up`), montant demandé et montant reçu confirmé par le prestataire en XOF. Un paiement
 * inconnu ou d'un autre objet reste introuvable.
 */
export class GetTopUpPaymentUseCase {
  constructor(private readonly deps: PaymentDeps) {}

  async execute(paymentId: string): Promise<{ payment: PaymentIntent; receivedAmount: number | null }> {
    requireCaller(TOP_UP_CALLERS);
    const payment = await this.deps.payments.findById(requireUuid('paymentId', paymentId));
    if (!payment || payment.subject.type !== 'wallet_top_up') throw PaymentErrors.notFound();
    return { payment, receivedAmount: payment.receivedAmount };
  }
}

/**
 * Recharge du portefeuille prépayé (ADR-046), demandée par wallet pour l'utilisateur de la requête
 * (transmis dans les métadonnées) : objet `wallet_top_up`, identifiant = titulaire du portefeuille
 * (l'organisation active, sinon le payeur). Le montant est celui choisi par le client, contrôlé par
 * wallet. Idempotent par (payeur, clé) ; une page encore ouverte du payeur pour le même titulaire est
 * réutilisée pour le même montant, remplacée (annulée) sinon : une seule page payable à la fois.
 *
 * Les refus d'ADR-032 propres à un montant dû (paiement réussi pas encore enregistré, écart non
 * traité) ne s'appliquent pas : une recharge est toujours un nouvel argent, jamais un second
 * paiement d'une même dette. La confirmation suit le chemin commun (notification signée, relecture,
 * rapprochement) ; un montant approuvé différent reste `amount_mismatch` et n'est pas crédité.
 */
export class CreateTopUpPaymentUseCase {
  private readonly sync: PaymentSync;

  constructor(private readonly deps: PaymentDeps) {
    this.sync = new PaymentSync(deps);
  }

  async execute(input: {
    idempotencyKey: string;
    amount: { amount: number; currency: string } | undefined;
  }): Promise<{ payment: PaymentIntent; created: boolean }> {
    requireCaller(TOP_UP_CALLERS);
    const payer = currentPayer();
    if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw PaymentErrors.invalid('idempotencyKey', 'Clé d’idempotence invalide (8 à 100 caractères).');
    }
    const amount = requireXof('amount', input.amount, MAX_AMOUNT);
    const subject: PaymentSubject = {
      type: 'wallet_top_up',
      id: payer.organizationId ?? payer.userId,
      part: null,
      reference: null,
    };
    const same = (intent: PaymentIntent) => sameSubject(intent.subject, subject) && intent.amount === amount;

    const replay = await this.deps.payments.findByIdempotencyKey(payer.userId, input.idempotencyKey);
    if (replay) {
      if (!same(replay)) throw PaymentErrors.keyReused();
      return { payment: await this.withCheckout(replay), created: false };
    }
    const now = this.deps.clock.now();
    const open = await this.deps.payments.findOpen({
      customerId: payer.userId,
      subjectType: 'wallet_top_up',
      subjectId: subject.id,
      part: null,
      now,
    });
    if (open && open.amount === amount) return { payment: await this.withCheckout(open), created: false };
    if (open) await this.sync.supersede(open);

    const stored = await this.deps.payments.create({
      id: this.deps.ids.next(),
      subject,
      amount,
      customerId: payer.userId,
      organizationId: payer.organizationId,
      paymentLinkId: null,
      status: 'pending',
      provider: this.deps.provider.name,
      providerTransactionId: null,
      providerReference: null,
      checkoutUrl: null,
      idempotencyKey: input.idempotencyKey,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: this.sync.expiry(now),
      completedAt: null,
      lastCheckedAt: null,
      mismatchResolution: null,
      receivedAmount: null,
      version: 0,
    });
    if (!stored.created && !same(stored.intent)) throw PaymentErrors.keyReused();
    return { payment: await this.withCheckout(stored.intent), created: stored.created };
  }

  /** Paiement en attente sans page (prestataire en panne au premier essai) : nouvel essai. */
  private withCheckout(intent: PaymentIntent): Promise<PaymentIntent> | PaymentIntent {
    if (intent.status !== 'pending' || intent.checkoutUrl) return intent;
    if (intent.expiresAt <= this.deps.clock.now()) return this.sync.expire(intent);
    return this.sync.startCheckout(intent);
  }
}
