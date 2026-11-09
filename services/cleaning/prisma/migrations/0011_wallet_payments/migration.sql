-- ADR-046 : paiement d'une mission par le portefeuille prépayé (moyen « wallet », reference = débit
-- du portefeuille) ; remboursé dans le portefeuille à l'annulation, il ne compte plus dans le payé.
ALTER TABLE "mission_payments" ADD COLUMN "refunded_at" TIMESTAMPTZ(3);
ALTER TABLE "mission_payments" ADD CONSTRAINT "mission_payments_refund_check" CHECK (
  "refunded_at" IS NULL OR ("method" = 'wallet' AND "reference" IS NOT NULL)
);
