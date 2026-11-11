-- ADR-048 : crédit manuel d'un portefeuille au-delà du seuil réglable : une demande attend la
-- validation d'un second membre de la finance (jamais son auteur) ; rien n'est écrit avant.
CREATE TABLE "manual_credit_requests" (
    "id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "holder_type" TEXT NOT NULL,
    "holder_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "payment_id" UUID,
    "status" TEXT NOT NULL,
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "transaction_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "manual_credit_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "manual_credit_requests_amount_check" CHECK ("amount" > 0),
    CONSTRAINT "manual_credit_requests_kind_check" CHECK (
      ("kind" = 'refund' AND "payment_id" IS NULL) OR ("kind" = 'top_up' AND "payment_id" IS NOT NULL)
    ),
    CONSTRAINT "manual_credit_requests_holder_check" CHECK ("holder_type" IN ('user', 'organization')),
    -- Validée : par un autre membre que l'auteur, datée, avec son écriture.
    CONSTRAINT "manual_credit_requests_status_check" CHECK (
      ("status" = 'pending_approval' AND "approved_by" IS NULL AND "transaction_id" IS NULL)
      OR ("status" = 'approved' AND "approved_by" IS NOT NULL AND "approved_by" <> "requested_by"
          AND "approved_at" IS NOT NULL AND "transaction_id" IS NOT NULL)
    ),
    CONSTRAINT "manual_credit_requests_transaction_id_fkey" FOREIGN KEY ("transaction_id")
      REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "manual_credit_requests_idempotency_key_key" ON "manual_credit_requests"("idempotency_key");
CREATE INDEX "manual_credit_requests_status_id_idx" ON "manual_credit_requests"("status", "id");
