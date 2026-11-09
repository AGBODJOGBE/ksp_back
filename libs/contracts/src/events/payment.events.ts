/**
 * Événements publiés par payment (paiement en ligne par Mobile Money, ADR-031). Source de vérité :
 * contracts/events/payment/*.schema.json. Identifiants et montants seulement : aucune donnée
 * personnelle (ni numéro de téléphone, ni nom du payeur).
 */
export interface PaymentMoney {
  amount: number;
  currency: 'XOF';
}

/** Objet payé : acompte ou solde d'une mission du Nettoyage, ou facture mensuelle. */
export type PaymentSubjectType = 'cleaning_mission' | 'billing_invoice';
/** Mission : acompte ou reste dû ; null pour une facture. */
export type PaymentPart = 'deposit' | 'balance';
export type PaymentProviderName = 'fedapay' | 'simulated';

interface PaymentRef {
  paymentId: string;
  subjectType: PaymentSubjectType;
  /** Mission (cleaning) ou facture (billing). */
  subjectId: string;
  part: PaymentPart | null;
  /** Numéro de la facture ; null pour une mission. */
  subjectReference: string | null;
  /** Payeur : compte qui a créé le paiement. */
  customerId: string;
  organizationId: string | null;
  amount: PaymentMoney;
  provider: PaymentProviderName;
}

export interface PaymentEventPayloads {
  'payment.intent.succeeded': PaymentRef & {
    method: 'mobile_money_online';
    /** Référence de la transaction chez le prestataire. */
    providerReference: string | null;
    succeededAt: string;
  };
  'payment.intent.failed': PaymentRef & {
    status: 'failed' | 'cancelled' | 'expired';
    failedAt: string;
  };
  /**
   * Lien de paiement payé par un payeur sans compte (ADR-040) ; distinct de payment.intent.succeeded,
   * réservé aux paiements par compte. Écouté par l'émetteur du lien selon `subjectType`.
   */
  'payment.link.paid': {
    paymentLinkId: string;
    paymentId: string;
    /** Type choisi par l'émetteur (par exemple `recovery_installment`). */
    subjectType: string;
    subjectId: string;
    /** Référence lisible de l'émetteur. */
    reference: string;
    amount: PaymentMoney;
    method: 'mobile_money_online';
    provider: PaymentProviderName;
    providerReference: string | null;
    paidAt: string;
  };
  /** Reversement terminé (prestataire, ou virement confirmé par la finance), ADR-041. */
  'payment.payout.completed': PayoutRef & {
    providerReference: string | null;
    completedAt: string;
  };
  /** Reversement en échec : aucun argent n'est parti (ADR-041). */
  'payment.payout.failed': PayoutRef & {
    failureCode: 'provider_failed' | 'rejected_by_finance';
    failedAt: string;
  };
}

/** Exécution d'un reversement : prestataire, ou virement fait à la main par la finance. */
export type PayoutProviderName = 'fedapay' | 'manual';

interface PayoutRef {
  payoutId: string;
  /** Service qui a demandé le reversement (wallet). */
  issuer: string;
  /** Référence de l'émetteur (wallet : identifiant de son reversement). */
  reference: string;
  amount: PaymentMoney;
  provider: PayoutProviderName;
}

export type PaymentEventType = keyof PaymentEventPayloads;
