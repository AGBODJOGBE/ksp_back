/**
 * Événements publiés par wallet (portefeuille prépayé des clients, ADR-046). Source de vérité :
 * contracts/events/wallet/*.schema.json. Identifiants, montants et libellés seulement.
 */
export interface WalletMoney {
  amount: number;
  currency: 'XOF';
}

/** Titulaire d'un portefeuille : un compte KSP ou une organisation. */
export interface WalletHolderRef {
  type: 'user' | 'organization';
  id: string;
}

/** Objet d'un service réglé par le portefeuille (paiement direct, v2). */
export interface WalletObjectRef {
  service: string;
  objectType: string;
  objectId: string;
  part: string | null;
}

export interface WalletEventPayloads {
  /** Paiement d'un service débité du portefeuille prépayé (cleaning, billing). */
  'wallet.prepaid.debited': {
    transactionId: string;
    holder: WalletHolderRef;
    /** Compte à prévenir : le titulaire, sinon le membre qui a payé ; null s'il est inconnu. */
    userId: string | null;
    amount: WalletMoney;
    /** Solde prépayé après le débit (jamais négatif). */
    balanceAfter: WalletMoney;
    /** Service appelant. */
    service: string;
    objectType: string;
    objectId: string;
    /** Part payée (deposit, balance), null sinon. */
    part: string | null;
    /** Libellé du relevé, par exemple « Nettoyage de maison — acompte ». */
    description: string;
    debitedAt: string;
  };
  /**
   * Portefeuille prépayé crédité : recharge confirmée (origin `payment`), remboursement d'un débit
   * par son service (`service`), ou crédit manuel de la finance avec motif (`finance`).
   *
   * Versions 1 et 2 (contracts/events/wallet/wallet.prepaid.credited.v1 et .v2) : la v2 ajoute
   * `commercial_gesture`, `topUpChannel` et `forObject` ; tout message v1 est un message v2 valide.
   * Publié en version 2 (enveloppe `version: 2`) avec le CDC Nettoyage v2 ; un consommateur déclare
   * `versions: [1, 2]`.
   */
  'wallet.prepaid.credited': {
    transactionId: string;
    /** `commercial_gesture` (v2 seulement) : geste commercial ou crédit d'une réclamation (Credit). */
    kind: 'top_up' | 'refund' | 'commercial_gesture';
    /** v2 seulement. Recharge : moyen de la recharge (R-WL-02, R-PE-04). */
    topUpChannel?: 'mobile_money_online' | 'card_online' | 'cash' | 'bank_transfer';
    /** v2 seulement. Paiement direct (R-WL-05, R-PE-04) : objet que ce crédit doit régler aussitôt. */
    forObject?: WalletObjectRef;
    origin: 'payment' | 'service' | 'finance';
    holder: WalletHolderRef;
    /** Compte à prévenir ; null s'il n'y en a pas (crédit de la finance à une organisation). */
    userId: string | null;
    amount: WalletMoney;
    balanceAfter: WalletMoney;
    description: string;
    /** Recharge : paiement Mobile Money crédité. */
    paymentId: string | null;
    /** Remboursement d'un débit : débit remboursé. */
    refundedTransactionId: string | null;
    creditedAt: string;
  };
}

export type WalletEventType = keyof WalletEventPayloads;
