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
 * ni billing, le paiement n'expire jamais et la finance tranche (ADR-031). Tant qu'elle ne l'a pas
 * traité (`mismatchResolution`), tout nouveau paiement du même objet est refusé (ADR-032) ; une fois
 * traité, le statut reste `amount_mismatch` (historique).
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

/**
 * Objets payés par un compte connecté : acompte ou solde d'une mission, facture, ou recharge du
 * portefeuille prépayé (ADR-046, demandée par wallet seulement). Réservés : un lien ne les porte
 * jamais.
 */
export type SubjectType = 'cleaning_mission' | 'billing_invoice' | 'wallet_top_up';
export const SUBJECT_TYPES: readonly SubjectType[] = ['cleaning_mission', 'billing_invoice', 'wallet_top_up'];

/** Objets dont le montant dû est lu dans le service qui les porte (CreatePayment, ADR-031). */
export type DueSubjectType = 'cleaning_mission' | 'billing_invoice';
export const DUE_SUBJECT_TYPES: readonly DueSubjectType[] = ['cleaning_mission', 'billing_invoice'];

/** Mission : acompte ou reste dû. */
export type MissionPart = 'deposit' | 'balance';
export const MISSION_PARTS: readonly MissionPart[] = ['deposit', 'balance'];

export type ProviderName = 'fedapay' | 'simulated';

/** Raison d'un paiement non abouti. */
export type FailureReason = 'declined' | 'cancelled' | 'expired';

export const CURRENCY = 'XOF';
export const ONLINE_METHOD = 'mobile_money_online';

export interface PaymentSubject {
  /**
   * `cleaning_mission` ou `billing_invoice` (paiement par compte) ; pour un lien de paiement, type
   * choisi par l'émetteur (`recovery_installment`…, ADR-040).
   */
  type: SubjectType | (string & {});
  /** Mission (cleaning), facture (billing) ou objet de l'émetteur d'un lien. */
  id: string;
  /** Mission seulement ; null pour une facture. */
  part: MissionPart | null;
  /** Numéro de la facture, ou référence de l'émetteur d'un lien ; null pour une mission. */
  reference: string | null;
}

/** Traitement d'un écart de montant par la finance (ADR-032). */
export interface MismatchResolution {
  resolvedAt: Date;
  /** Compte du back-office qui l'a traité. */
  resolvedBy: string;
  /** Ce que la finance a fait (remboursement, encaissement manuel enregistré…), 500 caractères au plus. */
  note: string;
  /** Clé d'idempotence de la demande, null si elle n'en avait pas. */
  idempotencyKey: string | null;
}

export interface PaymentIntent {
  id: string;
  subject: PaymentSubject;
  /** Entier en FCFA, strictement positif. */
  amount: number;
  /** Payeur : le compte connecté qui a créé le paiement ; null pour un paiement par lien. */
  customerId: string | null;
  /** Organisation payeuse (facture d'entreprise), null sinon. */
  organizationId: string | null;
  /**
   * Lien de paiement payé (payeur sans compte, ADR-040) ; null pour un paiement par compte. Un
   * paiement a toujours un payeur connecté ou un lien, jamais les deux.
   */
  paymentLinkId: string | null;
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
  /** Écart de montant traité par la finance ; null sinon (et pour tout autre statut). */
  mismatchResolution: MismatchResolution | null;
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

/**
 * Écart de montant pas encore traité par la finance : tant qu'il en existe un pour l'objet (mission,
 * toutes parts confondues, ou facture ; quel que soit le payeur), un nouveau paiement est refusé
 * (ADR-032).
 */
export function isUnderReview(intent: Pick<PaymentIntent, 'status' | 'mismatchResolution'>): boolean {
  return intent.status === 'amount_mismatch' && intent.mismatchResolution === null;
}

/** Issue d'une demande de traitement d'un écart de montant. */
export type MismatchResolutionOutcome =
  | { kind: 'resolved'; intent: PaymentIntent }
  /** Même demande déjà appliquée (même clé, ou même auteur et même note) : rien ne change. */
  | { kind: 'replay' }
  | { kind: 'refused'; reason: 'not_mismatch' | 'already_resolved' };

/**
 * Traitement d'un écart de montant par la finance : seul un paiement `amount_mismatch` non encore
 * traité l'accepte ; le statut ne change pas (historique). Une demande déjà appliquée est rejouée
 * sans effet ; un second traitement différent est refusé.
 */
export function resolveMismatch(
  intent: PaymentIntent,
  input: { by: string; note: string; idempotencyKey: string | null; now: Date },
): MismatchResolutionOutcome {
  if (intent.status !== 'amount_mismatch') return { kind: 'refused', reason: 'not_mismatch' };
  const done = intent.mismatchResolution;
  if (done) {
    const sameKey = input.idempotencyKey !== null && input.idempotencyKey === done.idempotencyKey;
    const sameRequest = done.resolvedBy === input.by && done.note === input.note;
    return sameKey || sameRequest ? { kind: 'replay' } : { kind: 'refused', reason: 'already_resolved' };
  }
  return {
    kind: 'resolved',
    intent: {
      ...intent,
      mismatchResolution: {
        resolvedAt: input.now,
        resolvedBy: input.by,
        note: input.note,
        idempotencyKey: input.idempotencyKey,
      },
      updatedAt: input.now,
    },
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
  if (subject.type === 'cleaning_mission') {
    return subject.part === 'deposit' ? 'KSP Nettoyage - Acompte' : 'KSP Nettoyage - Solde';
  }
  if (subject.type === 'wallet_top_up') return 'KSP - Recharge du portefeuille';
  // Lien de paiement : référence de l'émetteur (dossier, échéance), jamais le nom du payeur.
  return `KSP - Paiement ${subject.reference ?? ''}`.trim();
}
