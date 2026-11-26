/**
 * Réponse du créancier à une contestation (R-PR-02), tenue par la procédure amiable (décision
 * `dispute_response` du lot R4) : point d'entrée des contestations du débiteur (R3), comme
 * `SettlementTerms` pour les remises. Sans R4, `NO_DISPUTE_RESPONSES` ne demande rien.
 */
export interface DisputeResponses {
  /**
   * Contestation ouverte : réponse demandée au créancier jusqu'à l'échéance de la contestation
   * (`recovery.decision.requested`). Idempotent : rejouée, elle ne crée rien de plus.
   */
  requested(input: { caseId: string; disputeId: string }): Promise<void>;
  /** Contestation tranchée par le juriste : la demande encore ouverte est close. Idempotent. */
  settled(input: { caseId: string; disputeId: string }): Promise<void>;
}

/** Aucune décision du créancier (tests et services sans la procédure amiable). */
export const NO_DISPUTE_RESPONSES: DisputeResponses = {
  requested: async () => undefined,
  settled: async () => undefined,
};
