import { MAX_AMOUNT } from '../domain/payment-link';
import {
  directIdempotencyKey,
  type PaymentIntent,
  type PaymentSubject,
  type PaymentTarget,
  sameTarget,
} from '../domain/payment-intent';
import { type PaymentDeps } from './ports';
import { requireIssuer } from './shared/access';
import { PaymentErrors } from './shared/errors';
import { optionalUuid, requireInstant, requireText, requireUuid, requireXof } from './shared/validation';
import { PaymentSync } from './sync';

/** Clé d'idempotence d'un service demandeur : 8 à 100 caractères, lettres, chiffres, « : », « _ », « - ». */
const SERVICE_IDEMPOTENCY_KEY = /^[A-Za-z0-9:_-]{8,100}$/;
/** Type d'objet chez le service demandeur (payment.proto, PaymentTarget.object_type). */
const OBJECT_TYPE = /^[a-z0-9_]{3,50}$/;
/** Part payée : mêmes valeurs que wallet (ObjectReference.part). */
const OBJECT_PART = /^[a-z][a-z0-9_]{0,29}$/;
const MINUTE_MS = 60_000;
/** Échéance demandée : entre 15 minutes et 7 jours après la création. */
const MIN_EXPIRY_MS = 15 * MINUTE_MS;
const MAX_EXPIRY_MS = 7 * 24 * 60 * MINUTE_MS;

export interface PaymentRequestInput {
  idempotencyKey: string;
  customerId: string;
  /** Vide : contexte personnel. */
  organizationId: string;
  amount: { amount: number; currency: string } | undefined;
  /** `service` est ignoré : payment le tire du jeton de service. */
  target:
    { service: string; objectType: string; objectId: string; part: string; reference: string } | undefined;
  description: string;
  /** Vide : durée par défaut de payment. */
  expiresAt: string;
}

/**
 * Paiement direct du montant exact d'un objet (v2, R-WL-05, R-PP-03, R-PE-04 ; ADR-055 décision 2),
 * demandé par un service de PAYMENT_DIRECT_CALLERS (cleaning, billing). Un seul chemin pour l'argent :
 * c'est une recharge `wallet_top_up` du titulaire (l'organisation si elle est renseignée, sinon le
 * compte payeur) qui porte l'objet visé ; à la réussite, payment.intent.succeeded (avec `target`) fait
 * créditer le portefeuille par wallet, puis le service débite l'objet. Un montant reçu en trop reste
 * au portefeuille : un double paiement est impossible.
 *
 * Idempotent par (service, clé). Une page encore ouverte pour le même objet, le même montant et le
 * même payeur est réutilisée ; sinon (autre montant, autre payeur) elle est remplacée (annulée chez le
 * prestataire s'il le permet). Comme pour une recharge, les refus d'ADR-032 propres à un montant dû ne
 * s'appliquent pas : l'objet reste à son service, qui seul décide s'il est encore dû.
 */
export class CreatePaymentRequestUseCase {
  private readonly sync: PaymentSync;

  constructor(private readonly deps: PaymentDeps) {
    this.sync = new PaymentSync(deps);
  }

  async execute(input: PaymentRequestInput): Promise<{ payment: PaymentIntent; created: boolean }> {
    const service = requireIssuer(this.deps.settings.directCallers);
    if (!SERVICE_IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw PaymentErrors.invalid(
        'idempotencyKey',
        'Clé d’idempotence invalide (8 à 100 caractères : lettres, chiffres, « : », « _ » et « - »).',
      );
    }
    const customerId = requireUuid('customerId', input.customerId);
    const organizationId = optionalUuid('organizationId', input.organizationId) ?? null;
    const amount = requireXof('amount', input.amount, MAX_AMOUNT);
    const target = parseTarget(service, input.target);
    const description = requireText('description', input.description, 140);
    const now = this.deps.clock.now();
    const expiresAt = input.expiresAt ? requireExpiry(input.expiresAt, now) : this.sync.expiry(now);

    const key = directIdempotencyKey(service, input.idempotencyKey);
    const samePayer = (intent: PaymentIntent) =>
      intent.amount === amount &&
      intent.customerId === customerId &&
      intent.organizationId === organizationId;
    const same = (intent: PaymentIntent) => sameTarget(intent.target, target) && samePayer(intent);

    const replay = await this.deps.payments.findByServiceKey(service, key);
    if (replay) {
      if (!same(replay)) throw PaymentErrors.keyReused();
      return { payment: await this.sync.ensureCheckout(replay), created: false };
    }
    const open = await this.deps.payments.findOpenForTarget({ ...target, now });
    if (open && samePayer(open)) return { payment: await this.sync.ensureCheckout(open), created: false };
    if (open) await this.sync.supersede(open);

    const subject: PaymentSubject = {
      type: 'wallet_top_up',
      id: organizationId ?? customerId,
      part: null,
      reference: null,
    };
    const stored = await this.deps.payments.create({
      id: this.deps.ids.next(),
      subject,
      amount,
      customerId,
      organizationId,
      paymentLinkId: null,
      target,
      description,
      status: 'pending',
      provider: this.deps.provider.name,
      providerTransactionId: null,
      providerReference: null,
      checkoutUrl: null,
      idempotencyKey: key,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
      expiresAt,
      completedAt: null,
      lastCheckedAt: null,
      mismatchResolution: null,
      receivedAmount: null,
      version: 0,
    });
    if (!stored.created && !same(stored.intent)) throw PaymentErrors.keyReused();
    return { payment: await this.sync.ensureCheckout(stored.intent), created: stored.created };
  }
}

/** Objet visé : le service vient du jeton, jamais de la requête. */
function parseTarget(service: string, value: PaymentRequestInput['target']): PaymentTarget {
  if (!value) throw PaymentErrors.invalid('target', 'Objet visé obligatoire.');
  if (!OBJECT_TYPE.test(value.objectType ?? '')) {
    throw PaymentErrors.invalid('target.objectType', 'Type d’objet invalide (a-z, 0-9, « _ », 3 à 50).');
  }
  const objectId = requireUuid('target.objectId', value.objectId ?? '');
  const part = value.part ? value.part : null;
  if (part !== null && !OBJECT_PART.test(part)) throw PaymentErrors.invalid('target.part', 'Part invalide.');
  const reference = requireText('target.reference', value.reference, 60);
  return { service, objectType: value.objectType, objectId, part, reference };
}

/** Échéance demandée : date ISO 8601, entre 15 minutes et 7 jours après la création. */
function requireExpiry(value: string, now: Date): Date {
  const expiresAt = requireInstant('expiresAt', value);
  const delay = expiresAt.getTime() - now.getTime();
  if (delay < MIN_EXPIRY_MS || delay > MAX_EXPIRY_MS) {
    throw PaymentErrors.invalid('expiresAt', 'Échéance entre 15 minutes et 7 jours après la création.');
  }
  return expiresAt;
}
