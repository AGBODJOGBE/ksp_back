-- Paiement en ligne par Mobile Money (ADR-031) : intentions de paiement et journal des
-- notifications du prestataire (sans leur corps : il contient les coordonnées du payeur).

-- CreateTable
CREATE TABLE "payment_intents" (
    "id" UUID NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "part" TEXT,
    "subject_reference" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'XOF',
    "customer_id" UUID NOT NULL,
    "organization_id" UUID,
    "status" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_transaction_id" TEXT,
    "provider_reference" TEXT,
    "checkout_url" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "last_checked_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id"),
    -- Montant entier strictement positif, en XOF uniquement.
    CONSTRAINT "payment_intents_amount_check" CHECK ("amount" > 0 AND "currency" = 'XOF')
);

-- CreateTable
CREATE TABLE "provider_notifications" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "provider_event_id" TEXT,
    "provider_transaction_id" TEXT,
    "payment_id" UUID,
    "outcome" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "provider_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_customer_id_idempotency_key_key" ON "payment_intents"("customer_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_provider_provider_transaction_id_key" ON "payment_intents"("provider", "provider_transaction_id");

-- CreateIndex
CREATE INDEX "payment_intents_customer_id_id_idx" ON "payment_intents"("customer_id", "id");

-- CreateIndex
CREATE INDEX "payment_intents_organization_id_id_idx" ON "payment_intents"("organization_id", "id");

-- CreateIndex
CREATE INDEX "payment_intents_subject_id_status_idx" ON "payment_intents"("subject_id", "status");

-- CreateIndex
CREATE INDEX "payment_intents_status_last_checked_at_idx" ON "payment_intents"("status", "last_checked_at");

-- CreateIndex
CREATE INDEX "provider_notifications_payment_id_idx" ON "provider_notifications"("payment_id");

-- CreateIndex
CREATE INDEX "provider_notifications_received_at_idx" ON "provider_notifications"("received_at");
