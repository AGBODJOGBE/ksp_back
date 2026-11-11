-- ADR-048 : débits du portefeuille rapprochés avec le service qui les a faits (cleaning, billing).
-- Un débit vérifié (paiement enregistré) ou remboursé (paiement jamais enregistré) n'est plus relu.
CREATE TABLE "debit_checks" (
    "transaction_id" UUID NOT NULL,
    "outcome" TEXT NOT NULL,
    "checked_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "debit_checks_pkey" PRIMARY KEY ("transaction_id"),
    CONSTRAINT "debit_checks_outcome_check" CHECK ("outcome" IN ('recorded', 'refunded')),
    CONSTRAINT "debit_checks_transaction_id_fkey" FOREIGN KEY ("transaction_id")
      REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- Débits à relire : paiements de service, du plus ancien au plus récent.
CREATE INDEX "ledger_transactions_service_payment_created_at_idx" ON "ledger_transactions"("created_at")
  WHERE "kind" = 'service_payment';
