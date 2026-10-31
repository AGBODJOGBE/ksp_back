/**
 * Intention de paiement en ligne par Mobile Money (ADR-031) : un objet payé (acompte ou solde d'une
 * mission du Nettoyage, ou facture mensuelle), un montant dû lu dans le service qui le porte, un
 * payeur, une transaction chez le prestataire.
 *
 * Machine à états : `pending` → `succeeded` | `failed` | `cancelled` | `expired` | `amount_mismatch`.
 * Seul le prestataire fait passer un paiement à `succeeded` (statut relu chez lui), jamais le
 * navigateur. Une réussite confirmée l'emporte sur un échec, un abandon ou une expiration :
 * l'argent est reçu (paiement tardif sur une page encore ouverte). `amount_mismatch` : le
 * prestataire a approuvé un autre montant ou une autre devise ; rien n'est enregistré chez cleaning
 * ni billing, le paiement n'expire jamais et la finance tranche (ADR-031).
 */
export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'expired' | 'cancelled' | 'amount_mismatch';
export const PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'pending',
  'succeeded',
  'failed',
  'expired',
  'cancelled',
  'amount_mismatch',
];

/** Paiements non aboutis qu'une réussite tardive chez le prestataire peut encore régler. */
export const LATE_SUCCESS_STATUSES: readonly PaymentStatus[] = ['failed', 'expired', 'cancelled'];

export type SubjectType = 'cleaning_mission' | 'billing_invoice';
export const SUBJECT_TYPES: readonly SubjectType[] = ['cleaning_mission', 'billing_invoice'];

/** Mission : acompte ou reste dû. */
export type MissionPart = 'deposit' | 'balance';
export const MISSION_PARTS: readonly MissionPart[] = ['deposit', 'balance'];

export type ProviderName = 'fedapay' | 'simulated';

/** Raison d'un paiement non abouti. */
export type FailureReason = 'declined' | 'cancelled' | 'expired';

export const CURRENCY = 'XOF';
export const ONLINE_METHOD = 'mobile_money_online';

export interface PaymentSubject {
  type: SubjectType;
  /** Mission (cleaning) ou facture (billing). */
  id: string;
  /** Mission seulement ; null pour une facture. */
  part: MissionPart | null;
  /** Numéro de la facture ; null pour une mission. */
  reference: string | null;
}

export interface PaymentIntent {
  id: string;
  subject: PaymentSubject;
  /** Entier en FCFA, strictement positif. */
  amount: number;
  /** Payeur : le compte connecté qui a créé le paiement. */
  customerId: string;
  /** Organisation payeuse (facture d'entreprise), null sinon. */
  organizationId: string | null;
  status: PaymentStatus;
  provider: ProviderName;
  /** Identifiant de la transaction chez le prestataire ; null tant qu'elle n'est pas créée. */
  providerTransactionId: string | null;
  providerReference: string | null;
  checkoutUrl: string | null;
  idempotencyKey: string;
  failureReason: FailureReason | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  completedAt: Date | null;
  /** Dernière interrogation du prestataire (limite les relectures). */
  lastCheckedAt: Date | null;
  version: number;
}

/**
 * Statut d'une transaction chez le prestataire, traduit par l'adaptateur. `refunded` (remboursement)
 * est hors du périmètre (ADR-031, différé) : il ne change rien ici. `unknown` : valeur inattendue.
 */
export type ProviderStatus =
  'pending' | 'approved' | 'declined' | 'canceled' | 'expired' | 'refunded' | 'unknown';

export function isTerminal(status: PaymentStatus): boolean {
  return status !== 'pending';
}

/** Effet d'un statut du prestataire sur le paiement : nouvel état, ou null si rien ne change. */
export type Transition =
  | { kind: 'succeeded'; intent: PaymentIntent }
  | { kind: 'failed'; intent: PaymentIntent }
  | { kind: 'amount_mismatch'; intent: PaymentIntent }
  | null;

/**
 * Applique le statut lu chez le prestataire. Une réussite l'emporte sur tout état sauf `succeeded`
 * (idempotent) ; un refus, un abandon ou une expiration ne s'appliquent qu'à un paiement en attente.
 */
export function applyProviderStatus(intent: PaymentIntent, status: ProviderStatus, now: Date): Transition {
  if (status === 'approved') {
    if (intent.status === 'succeeded' || intent.status === 'amount_mismatch') return null;
    return {
      kind: 'succeeded',
      intent: { ...intent, status: 'succeeded', failureReason: null, completedAt: now, updatedAt: now },
    };
  }
  if (intent.status !== 'pending') return null;
  const reason: FailureReason | null =
    status === 'declined'
      ? 'declined'
      : status === 'canceled'
        ? 'cancelled'
        : status === 'expired'
          ? 'expired'
          : null;
  if (!reason) return null;
  return { kind: 'failed', intent: failed(intent, reason, now) };
}

/** Paiement en attente au-delà de son délai, sans réussite chez le prestataire : expiré. */
export function expire(intent: PaymentIntent, now: Date): Transition {
  if (intent.status !== 'pending' || intent.expiresAt > now) return null;
  return { kind: 'failed', intent: failed(intent, 'expired', now) };
}

/**
 * Approbation d'un montant ou d'une devise différents : écart à trancher par la finance. Jamais
 * depuis `succeeded` ; idempotent.
 */
export function flagAmountMismatch(intent: PaymentIntent, now: Date): Transition {
  if (intent.status === 'succeeded' || intent.status === 'amount_mismatch') return null;
  return {
    kind: 'amount_mismatch',
    intent: { ...intent, status: 'amount_mismatch', failureReason: null, completedAt: now, updatedAt: now },
  };
}

/** Paiement en attente remplacé par un nouveau pour le même objet (montant dû changé) : annulé. */
export function supersede(intent: PaymentIntent, now: Date): Transition {
  if (intent.status !== 'pending') return null;
  return { kind: 'failed', intent: failed(intent, 'cancelled', now) };
}

function failed(intent: PaymentIntent, reason: FailureReason, now: Date): PaymentIntent {
  const status: PaymentStatus = reason === 'declined' ? 'failed' : reason;
  return { ...intent, status, failureReason: reason, completedAt: now, updatedAt: now };
}

/** Montant confirmé par le prestataire : il doit être exactement celui du paiement, en XOF. */
export function amountMatches(
  intent: Pick<PaymentIntent, 'amount'>,
  amount: number,
  currency: string,
): boolean {
  return amount === intent.amount && currency.toUpperCase() === CURRENCY;
}

/** Même objet payé (type, identifiant, part). */
export function sameSubject(a: PaymentSubject, b: Pick<PaymentSubject, 'type' | 'id' | 'part'>): boolean {
  return a.type === b.type && a.id === b.id && a.part === b.part;
}

/** Libellé du paiement chez le prestataire : aucune donnée personnelle, aucune adresse. */
export function providerDescription(subject: PaymentSubject): string {
  if (subject.type === 'billing_invoice') return `KSP - Facture ${subject.reference ?? ''}`.trim();
  return subject.part === 'deposit' ? 'KSP Nettoyage - Acompte' : 'KSP Nettoyage - Solde';
}
