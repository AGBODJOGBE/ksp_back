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
}

export type PaymentEventType = keyof PaymentEventPayloads;
