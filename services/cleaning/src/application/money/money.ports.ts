/**
 * Argent du Nettoyage v2 hors du wallet de la demande (ADR-055) : solde prépayé et paiement direct
 * par Mobile Money. Ports communs aux frais de visite (lot C) et au paiement d'une séance (lot E).
 */

/** Titulaire d'un portefeuille : compte personnel ou organisation. */
export interface WalletHolder {
  type: 'user' | 'organization';
  id: string;
}

/** Solde prépayé disponible (wallet.GetPrepaidBalance), en XOF. */
export interface PrepaidBalances {
  available(holder: WalletHolder): Promise<number>;
}

/** Objet que le paiement direct doit régler aussitôt (PaymentTarget, service renseigné par payment). */
export interface DirectPaymentTarget {
  /** « cleaning_request » (frais de visite), « cleaning_session ». */
  objectType: string;
  objectId: string;
  /** Part payée (« visit_fee ») ; null sinon. */
  part: string | null;
  /** Référence lisible (« DN-000124 », « séance 3/15 »), 1 à 60 caractères. */
  reference: string;
}

export interface DirectPaymentPage {
  paymentId: string;
  checkoutUrl: string | null;
  expiresAt: Date | null;
  /** false : clé déjà servie, ou page encore ouverte réutilisée par payment. */
  created: boolean;
}

/**
 * Paiement direct du montant qui manque au solde (payment.CreatePaymentRequest, R-WL-05, RV-95) :
 * une recharge du portefeuille qui porte l'objet visé. Le débit de l'objet suit le crédit
 * (wallet.prepaid.credited avec forObject), jamais payment.intent.succeeded. Idempotent par clé ;
 * les erreurs de payment sont transmises telles quelles.
 */
export interface DirectPayments {
  createPaymentRequest(input: {
    idempotencyKey: string;
    customerId: string;
    organizationId: string | null;
    amount: number;
    target: DirectPaymentTarget;
    description: string;
    /** Au plus l'échéance de l'objet (R-PP-07, RV-89) ; null : durée par défaut de payment. */
    expiresAt: Date | null;
  }): Promise<DirectPaymentPage>;
}
