/**
 * Remise pour paiement immédiat (R-PR-05), tenue par le lot R4 (table `settlements`) : point d'entrée
 * du paiement par lien d'une remise (`CreateDebtorPayment.settlement_id`). Tant que R4 n'est pas
 * branché, `NO_SETTLEMENTS` répond « aucune remise » ; à la fusion, l'adaptateur de R4 rend la remise
 * au statut `proposed` ou `accepted`, encore valable, et la passe à `executed` quand elle est payée.
 */
export interface PayableSettlement {
  id: string;
  caseId: string;
  /** Montant à payer tout de suite, contre l'abandon du reste. */
  payNow: number;
  validUntil: Date;
}

export interface SettlementTerms {
  /** Remise payable du dossier, ou null : inconnue, d'un autre dossier, expirée, refusée, exécutée. */
  payable(input: { caseId: string; settlementId: string; at: Date }): Promise<PayableSettlement | null>;
  /**
   * Lien de la remise payé, encaissement enregistré : la remise est exécutée (solde abandonné, clôture
   * « accord transactionnel exécuté »). Idempotent ; repris au prochain paiement s'il échoue.
   */
  paid(input: { settlementId: string; caseId: string; collectionId: string; at: Date }): Promise<void>;
}

/** Aucune remise en attendant R4. */
export const NO_SETTLEMENTS: SettlementTerms = {
  payable: async () => null,
  paid: async () => undefined,
};
