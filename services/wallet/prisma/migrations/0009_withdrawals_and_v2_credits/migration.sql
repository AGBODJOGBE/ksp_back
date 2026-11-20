-- CDC Nettoyage v2 (R-WL-02, R-WL-04, R-PE-04 ; ADR-055, décision 8) : crédit décidé par un service,
-- recharges en espèces et virements saisis par la finance (toujours validés par une deuxième
-- personne, rejetables), retrait du portefeuille prépayé vers Mobile Money. Ajouts seulement : les
-- écritures existantes restent immuables (aucune ligne n'est modifiée).

-- 1. Retraits demandés, pas encore virés (passif, sens crédit). Invariant v2 : fonds des recharges =
--    Σ portefeuilles + services payés + retraits en transit.
INSERT INTO "ledger_accounts" ("code", "kind", "normal_side") VALUES
  ('ksp:prepaid_withdrawals_in_transit', 'internal', 'credit');

-- 2. Écritures v2 : crédit d'un service, retenue, sortie et restitution d'un retrait.
ALTER TABLE "ledger_transactions" DROP CONSTRAINT "ledger_transactions_kind_check";
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_kind_check" CHECK (
  "kind" IN ('collection', 'payout_hold', 'payout_settlement', 'payout_release', 'reversal',
             'top_up', 'service_payment', 'refund',
             'service_credit', 'withdrawal_hold', 'withdrawal_settlement', 'withdrawal_release')
);

-- 3. Crédits manuels v2 : reçu (espèces, virement), objet à régler aussitôt, rejet motivé.
ALTER TABLE "manual_credit_requests"
  ADD COLUMN "receipt_reference" TEXT,
  ADD COLUMN "for_object_service" TEXT,
  ADD COLUMN "for_object_type" TEXT,
  ADD COLUMN "for_object_id" UUID,
  ADD COLUMN "for_object_part" TEXT,
  ADD COLUMN "rejected_by" UUID,
  ADD COLUMN "rejected_at" TIMESTAMPTZ(3),
  ADD COLUMN "rejection_reason" TEXT;

ALTER TABLE "manual_credit_requests" DROP CONSTRAINT "manual_credit_requests_kind_check";
ALTER TABLE "manual_credit_requests" ADD CONSTRAINT "manual_credit_requests_kind_check" CHECK (
  ("kind" = 'refund' AND "payment_id" IS NULL AND "receipt_reference" IS NULL AND "for_object_type" IS NULL)
  OR ("kind" = 'top_up' AND "payment_id" IS NOT NULL AND "receipt_reference" IS NULL)
  OR ("kind" IN ('cash_top_up', 'bank_transfer_top_up') AND "payment_id" IS NULL
      AND "receipt_reference" IS NOT NULL AND length("receipt_reference") BETWEEN 1 AND 100)
);
ALTER TABLE "manual_credit_requests" ADD CONSTRAINT "manual_credit_requests_for_object_check" CHECK (
  ("for_object_service" IS NULL AND "for_object_type" IS NULL AND "for_object_id" IS NULL AND "for_object_part" IS NULL)
  OR ("for_object_service" IS NOT NULL AND "for_object_type" IS NOT NULL AND "for_object_id" IS NOT NULL)
);
-- Validée : par un autre membre que l'auteur ; rejetée : auteur, date et motif, sans crédit.
ALTER TABLE "manual_credit_requests" DROP CONSTRAINT "manual_credit_requests_status_check";
ALTER TABLE "manual_credit_requests" ADD CONSTRAINT "manual_credit_requests_status_check" CHECK (
  ("status" = 'pending_approval' AND "approved_by" IS NULL AND "transaction_id" IS NULL AND "rejected_by" IS NULL)
  OR ("status" = 'approved' AND "approved_by" IS NOT NULL AND "approved_by" <> "requested_by"
      AND "approved_at" IS NOT NULL AND "transaction_id" IS NOT NULL AND "rejected_by" IS NULL)
  OR ("status" = 'rejected' AND "approved_by" IS NULL AND "transaction_id" IS NULL
      AND "rejected_by" IS NOT NULL AND "rejected_at" IS NOT NULL AND "rejection_reason" IS NOT NULL)
);

-- 4. Retraits vers Mobile Money (R-WL-04) : montant retenu à la demande, traité par la finance, validé
--    par une deuxième personne, viré par payment (référence « wallet_withdrawal:<id> »). Numéro complet
--    et nom gardés seulement jusqu'à la transmission à payment (ou au refus).
CREATE TABLE "wallet_withdrawals" (
    "id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "holder_type" TEXT NOT NULL,
    "holder_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "beneficiary_phone" TEXT,
    "beneficiary_name" TEXT,
    "beneficiary_phone_masked" TEXT NOT NULL,
    "beneficiary_phone_hash" TEXT NOT NULL,
    "beneficiary_operator" TEXT NOT NULL,
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL,
    "processed_by" UUID,
    "processed_at" TIMESTAMPTZ(3),
    "processing_note" TEXT,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "rejected_by" UUID,
    "rejected_at" TIMESTAMPTZ(3),
    "rejection_reason" TEXT,
    "payment_payout_id" TEXT,
    "hold_transaction_id" UUID NOT NULL,
    "settlement_transaction_id" UUID,
    "completed_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "wallet_withdrawals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "wallet_withdrawals_amount_check" CHECK ("amount" > 0),
    CONSTRAINT "wallet_withdrawals_holder_check" CHECK ("holder_type" IN ('user', 'organization')),
    CONSTRAINT "wallet_withdrawals_status_check" CHECK (
      "status" IN ('requested', 'awaiting_approval', 'submitted', 'completed', 'failed', 'rejected')
    ),
    CONSTRAINT "wallet_withdrawals_operator_check" CHECK ("beneficiary_operator" IN ('mtn', 'moov', 'celtiis')),
    CONSTRAINT "wallet_withdrawals_phone_hash_check" CHECK ("beneficiary_phone_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "wallet_withdrawals_phone_check" CHECK (
      "status" IN ('requested', 'awaiting_approval')
      OR ("beneficiary_phone" IS NULL AND "beneficiary_name" IS NULL)
    ),
    -- Double validation : la personne qui valide n'est jamais celle qui a traité.
    CONSTRAINT "wallet_withdrawals_approval_check" CHECK (
      "approved_by" IS NULL OR ("processed_by" IS NOT NULL AND "approved_by" <> "processed_by")
    ),
    -- Soldé (terminé, en échec ou refusé) si et seulement si son écriture finale existe.
    CONSTRAINT "wallet_withdrawals_settlement_check" CHECK (
      ("status" IN ('completed', 'failed', 'rejected')) = ("settlement_transaction_id" IS NOT NULL)
    ),
    CONSTRAINT "wallet_withdrawals_hold_transaction_id_fkey" FOREIGN KEY ("hold_transaction_id")
      REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "wallet_withdrawals_settlement_transaction_id_fkey" FOREIGN KEY ("settlement_transaction_id")
      REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "wallet_withdrawals_holder_type_holder_id_idempotency_key_key"
  ON "wallet_withdrawals"("holder_type", "holder_id", "idempotency_key");
CREATE INDEX "wallet_withdrawals_holder_type_holder_id_id_idx" ON "wallet_withdrawals"("holder_type", "holder_id", "id");
CREATE INDEX "wallet_withdrawals_status_id_idx" ON "wallet_withdrawals"("status", "id");
