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
   */
  'wallet.prepaid.credited': {
    transactionId: string;
    kind: 'top_up' | 'refund';
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
