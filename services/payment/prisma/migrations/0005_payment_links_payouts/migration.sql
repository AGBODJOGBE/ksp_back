-- ADR-038 : liens de paiement (payeur sans compte KSP). ADR-039 : reversements par Mobile Money.

-- CreateTable
CREATE TABLE "payment_links" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "beneficiary_name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'XOF',
    "due_date" TEXT,
    "payer_name" TEXT,
    "payer_phone" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "payment_links_pkey" PRIMARY KEY ("id"),
    -- Montant entier XOF positif ; types du paiement par compte réservés.
    CONSTRAINT "payment_links_amount_check" CHECK ("amount" > 0 AND "currency" = 'XOF'),
    CONSTRAINT "payment_links_subject_type_check" CHECK (
      "subject_type" ~ '^[a-z][a-z0-9_]{2,49}$' AND "subject_type" NOT IN ('cleaning_mission', 'billing_invoice')
    )
);

CREATE UNIQUE INDEX "payment_links_token_hash_key" ON "payment_links"("token_hash");
CREATE UNIQUE INDEX "payment_links_issuer_idempotency_key_key" ON "payment_links"("issuer", "idempotency_key");
CREATE INDEX "payment_links_subject_type_subject_id_idx" ON "payment_links"("subject_type", "subject_id");

-- Paiement par lien : pas de payeur connecté. Exactement un des deux : payeur ou lien.
ALTER TABLE "payment_intents" ALTER COLUMN "customer_id" DROP NOT NULL,
ADD COLUMN "payment_link_id" UUID;

ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_payment_link_id_fkey"
  FOREIGN KEY ("payment_link_id") REFERENCES "payment_links"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_payer_check"
  CHECK (("customer_id" IS NULL) <> ("payment_link_id" IS NULL));

CREATE UNIQUE INDEX "payment_intents_payment_link_id_idempotency_key_key"
  ON "payment_intents"("payment_link_id", "idempotency_key");

-- CreateTable
CREATE TABLE "payouts" (
    "id" UUID NOT NULL,
    "issuer" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'XOF',
    "beneficiary_phone" TEXT NOT NULL,
    "beneficiary_operator" TEXT NOT NULL,
    "beneficiary_name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_payout_id" TEXT,
    "provider_reference" TEXT,
    "failure_code" TEXT,
    "failure_reason" TEXT,
    "settled_by" UUID,
    "settlement_key" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "submitted_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "last_checked_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payouts_amount_check" CHECK ("amount" > 0 AND "currency" = 'XOF'),
    CONSTRAINT "payouts_status_check" CHECK ("status" IN ('requested', 'processing', 'completed', 'failed')),
    -- Une issue est complète : terminé daté, échec daté et codé.
    CONSTRAINT "payouts_outcome_check" CHECK (
      ("status" <> 'completed' OR "completed_at" IS NOT NULL)
      AND ("status" <> 'failed' OR ("failed_at" IS NOT NULL AND "failure_code" IS NOT NULL))
    )
);

CREATE UNIQUE INDEX "payouts_issuer_idempotency_key_key" ON "payouts"("issuer", "idempotency_key");
CREATE UNIQUE INDEX "payouts_provider_provider_payout_id_key" ON "payouts"("provider", "provider_payout_id");
CREATE INDEX "payouts_status_last_checked_at_idx" ON "payouts"("status", "last_checked_at");
