/**
 * Reversement par Mobile Money (ADR-041) : un service autorisé (wallet) fait verser un montant à un
 * bénéficiaire (créancier). Exécution par le prestataire (FedaPay) ou, en mode manuel, par la
 * finance qui fait le virement et le confirme au back-office.
 *
 * Machine à états : `requested` → `processing` (lancé chez le prestataire) → `completed` | `failed` ;
 * en mode manuel, `requested` → `completed` | `failed` directement. Une issue est définitive et
 * publiée une seule fois (payment.payout.completed ou payment.payout.failed).
 *
 * Prestataire : le reversement y est d'abord créé (aucun argent ne part), puis lancé. Une création
 * dont la réponse se perd laisse au pire un reversement jamais lancé chez lui ; le lancement ne se
 * fait que sur l'identifiant enregistré, jamais deux fois sur deux reversements différents.
 */
export type PayoutStatus = 'requested' | 'processing' | 'completed' | 'failed';
export const PAYOUT_STATUSES: readonly PayoutStatus[] = ['requested', 'processing', 'completed', 'failed'];

/** Opérateurs Mobile Money du Bénin. */
export type PayoutOperator = 'mtn' | 'moov' | 'celtiis';
export const PAYOUT_OPERATORS: readonly PayoutOperator[] = ['mtn', 'moov', 'celtiis'];

export type PayoutProviderName = 'fedapay' | 'manual';

/** Code d'échec publié (la raison détaillée reste dans payment). */
export type PayoutFailureCode = 'provider_failed' | 'rejected_by_finance';

/** Numéro béninois E.164 : +229 suivi de 8 chiffres (ancien plan) ou de 10 (depuis 2024). */
export const BENIN_PHONE = /^\+229(\d{8}|\d{10})$/;

export interface PayoutBeneficiary {
  phone: string;
  operator: PayoutOperator;
  name: string;
}

export interface Payout {
  id: string;
  /** Service qui l'a demandé (jeton de service). */
  issuer: string;
  idempotencyKey: string;
  /** Référence de l'émetteur, reprise dans les événements. */
  reference: string;
  /** Entier en FCFA, strictement positif. */
  amount: number;
  beneficiary: PayoutBeneficiary;
  status: PayoutStatus;
  provider: PayoutProviderName;
  /** Reversement chez le prestataire, null tant qu'il n'y est pas créé (et en mode manuel). */
  providerPayoutId: string | null;
  /** Référence du virement : chez le prestataire, ou saisie par la finance. */
  providerReference: string | null;
  failureCode: PayoutFailureCode | null;
  /** Raison détaillée d'un échec (prestataire ou note de la finance) : jamais publiée. */
  failureReason: string | null;
  /** Mode manuel : compte du back-office qui a tranché, et clé d'idempotence de sa demande. */
  settledBy: string | null;
  settlementKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Lancement demandé au prestataire. */
  submittedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  /** Dernière relecture chez le prestataire (limite les relectures). */
  lastCheckedAt: Date | null;
  version: number;
}

/** Statut d'un reversement chez le prestataire, traduit par l'adaptateur. */
export type ProviderPayoutStatus = 'pending' | 'processing' | 'sent' | 'failed' | 'unknown';

/** Nouvel état et issue publiée, ou null si rien ne change. */
export type PayoutTransition = { kind: 'completed' | 'failed' | 'processing'; payout: Payout } | null;

export function isSettled(status: PayoutStatus): boolean {
  return status === 'completed' || status === 'failed';
}

/** Numéro masqué pour l'affichage : seuls les deux derniers chiffres. */
export function maskPhone(phone: string): string {
  return `${phone.slice(0, 4)} •• •• ${phone.slice(-2)}`;
}

/** Reversement créé chez le prestataire (aucun argent n'est parti). */
export function recordProviderPayout(
  payout: Payout,
  input: { providerPayoutId: string; reference: string | null; now: Date },
): Payout {
  return {
    ...payout,
    providerPayoutId: input.providerPayoutId,
    providerReference: payout.providerReference ?? input.reference,
    updatedAt: input.now,
  };
}

/** Lancement demandé au prestataire : `processing`. */
export function markSubmitted(payout: Payout, now: Date): PayoutTransition {
  if (payout.status !== 'requested' || !payout.providerPayoutId) return null;
  return {
    kind: 'processing',
    payout: { ...payout, status: 'processing', submittedAt: now, updatedAt: now },
  };
}

/** Applique le statut relu chez le prestataire. Une issue définitive ne change plus. */
export function applyProviderPayoutStatus(
  payout: Payout,
  status: ProviderPayoutStatus,
  input: { reference: string | null; now: Date },
): PayoutTransition {
  if (isSettled(payout.status)) return null;
  const now = input.now;
  if (status === 'sent') {
    return {
      kind: 'completed',
      payout: {
        ...payout,
        status: 'completed',
        providerReference: input.reference ?? payout.providerReference,
        completedAt: now,
        updatedAt: now,
      },
    };
  }
  if (status === 'failed') {
    return {
      kind: 'failed',
      payout: {
        ...payout,
        status: 'failed',
        failureCode: 'provider_failed',
        failureReason: 'Refusé par le prestataire.',
        failedAt: now,
        updatedAt: now,
      },
    };
  }
  if (status === 'processing' && payout.status === 'requested') {
    return {
      kind: 'processing',
      payout: { ...payout, status: 'processing', submittedAt: payout.submittedAt ?? now, updatedAt: now },
    };
  }
  return null;
}

/** Issue d'une décision de la finance sur un reversement manuel. */
export type ManualSettlement =
  | { kind: 'settled'; transition: NonNullable<PayoutTransition> }
  /** Même décision déjà appliquée (même clé, ou même issue, même auteur, même texte). */
  | { kind: 'replay' }
  | { kind: 'refused'; reason: 'not_manual' | 'already_settled' };

/**
 * La finance a fait le virement (`completed`, référence obligatoire) ou n'a pas pu le faire (`failed`,
 * raison obligatoire). Seul un reversement manuel encore `requested` l'accepte.
 */
export function settleManually(
  payout: Payout,
  input: {
    outcome: 'completed' | 'failed';
    /** Référence du virement (completed) ou raison (failed). */
    text: string;
    by: string;
    idempotencyKey: string | null;
    now: Date;
  },
): ManualSettlement {
  if (payout.provider !== 'manual') return { kind: 'refused', reason: 'not_manual' };
  if (isSettled(payout.status)) {
    const sameKey = input.idempotencyKey !== null && input.idempotencyKey === payout.settlementKey;
    const sameText =
      input.outcome === 'completed'
        ? payout.providerReference === input.text
        : payout.failureReason === input.text;
    const sameRequest = payout.status === input.outcome && payout.settledBy === input.by && sameText;
    return sameKey || sameRequest ? { kind: 'replay' } : { kind: 'refused', reason: 'already_settled' };
  }
  const now = input.now;
  const common = { settledBy: input.by, settlementKey: input.idempotencyKey, updatedAt: now };
  if (input.outcome === 'completed') {
    return {
      kind: 'settled',
      transition: {
        kind: 'completed',
        payout: {
          ...payout,
          ...common,
          status: 'completed',
          providerReference: input.text,
          completedAt: now,
        },
      },
    };
  }
  return {
    kind: 'settled',
    transition: {
      kind: 'failed',
      payout: {
        ...payout,
        ...common,
        status: 'failed',
        failureCode: 'rejected_by_finance',
        failureReason: input.text,
        failedAt: now,
      },
    },
  };
}
