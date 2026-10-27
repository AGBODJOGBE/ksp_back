-- Facturation mensuelle des contrats d'entreprise du Nettoyage (CDC Nettoyage, partie 10).

-- CreateTable
CREATE TABLE "billing_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "payment_term_days" INTEGER NOT NULL DEFAULT 10,
    "updated_by" TEXT,
    "updated_at" TIMESTAMPTZ(3),

    CONSTRAINT "billing_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_contracts" (
    "id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "organization_id" UUID,
    "total" INTEGER NOT NULL,
    "duration_months" INTEGER NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "terminated_at" TIMESTAMPTZ(3),
    "suspended_since" TIMESTAMPTZ(3),
    "suspensions" JSONB NOT NULL DEFAULT '[]',
    "last_resumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "billing_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "contract_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "organization_id" UUID,
    "source" TEXT NOT NULL,
    "period_index" INTEGER NOT NULL,
    "period_start" TIMESTAMPTZ(3) NOT NULL,
    "period_end" TIMESTAMPTZ(3) NOT NULL,
    "lines" JSONB NOT NULL,
    "total" INTEGER NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL,
    "due_at" TIMESTAMPTZ(3) NOT NULL,
    "paid_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_payments" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "recorded_by" TEXT NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invoice_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_counters" (
    "year" INTEGER NOT NULL,
    "last_number" INTEGER NOT NULL,

    CONSTRAINT "invoice_counters_pkey" PRIMARY KEY ("year")
);

-- CreateIndex
CREATE INDEX "billing_contracts_terminated_at_idx" ON "billing_contracts"("terminated_at");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_number_key" ON "invoices"("number");

-- CreateIndex
CREATE INDEX "invoices_customer_id_id_idx" ON "invoices"("customer_id", "id");

-- CreateIndex
CREATE INDEX "invoices_organization_id_id_idx" ON "invoices"("organization_id", "id");

-- CreateIndex
CREATE INDEX "invoices_status_due_at_idx" ON "invoices"("status", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_contract_id_period_index_key" ON "invoices"("contract_id", "period_index");

-- CreateIndex
CREATE INDEX "invoice_payments_invoice_id_idx" ON "invoice_payments"("invoice_id");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "billing_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Réglages par défaut.
INSERT INTO "billing_settings" ("id", "payment_term_days") VALUES (1, 10);
