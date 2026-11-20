-- Lot F — facture mensuelle des organisations (CDC Nettoyage v2, partie 11.2 ; ADR-055 décision 5).
-- Migration additive : une facture v2 n'a pas de contrat (RV-98) ; séances facturables apprises par
-- les événements de séance de cleaning ; relances (R-PE-05) ; avoirs (R-PE-07). Les factures v1 et
-- leurs contrats ne changent pas.

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "cancelled_at" TIMESTAMPTZ(3),
ADD COLUMN     "credit_notes_total" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "credited_amount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "kind" TEXT,
ADD COLUMN     "settled_by" TEXT,
ALTER COLUMN "contract_id" DROP NOT NULL,
ALTER COLUMN "period_index" DROP NOT NULL;

-- CreateTable
CREATE TABLE "billable_sessions" (
    "session_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "program_number" TEXT NOT NULL,
    "place_id" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "sessions_count" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "amount_due" INTEGER NOT NULL,
    "visit_fee_deduction" INTEGER NOT NULL,
    "invoice_id" UUID,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "billable_sessions_pkey" PRIMARY KEY ("session_id")
);

-- CreateTable
CREATE TABLE "invoice_reminders" (
    "invoice_id" UUID NOT NULL,
    "offset_days" INTEGER NOT NULL,
    "sent" BOOLEAN NOT NULL,
    "handled_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invoice_reminders_pkey" PRIMARY KEY ("invoice_id","offset_days")
);

-- CreateTable
CREATE TABLE "credit_notes" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "invoice_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "organization_id" UUID,
    "lines" JSONB NOT NULL,
    "total" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "issued_by" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL,
    "applied_to_balance" INTEGER NOT NULL,
    "credited_to_wallet" INTEGER NOT NULL,
    "wallet_transaction_id" TEXT,
    "source_object_type" TEXT,
    "source_object_id" TEXT,
    "idempotency_key" TEXT NOT NULL,

    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_note_counters" (
    "year" INTEGER NOT NULL,
    "last_number" INTEGER NOT NULL,

    CONSTRAINT "credit_note_counters_pkey" PRIMARY KEY ("year")
);

-- CreateIndex
CREATE INDEX "billable_sessions_organization_id_occurred_at_idx" ON "billable_sessions"("organization_id", "occurred_at");

-- CreateIndex
CREATE INDEX "billable_sessions_invoice_id_idx" ON "billable_sessions"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_number_key" ON "credit_notes"("number");

-- CreateIndex
CREATE INDEX "credit_notes_invoice_id_idx" ON "credit_notes"("invoice_id");

-- CreateIndex
CREATE INDEX "credit_notes_organization_id_id_idx" ON "credit_notes"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_issued_by_idempotency_key_key" ON "credit_notes"("issued_by", "idempotency_key");

-- CreateIndex
CREATE INDEX "invoices_kind_status_due_at_idx" ON "invoices"("kind", "status", "due_at");

-- AddForeignKey
ALTER TABLE "billable_sessions" ADD CONSTRAINT "billable_sessions_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_reminders" ADD CONSTRAINT "invoice_reminders_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Une facture est soit v1 (contrat et rang du mois), soit v2 (nature renseignée).
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_contract_or_kind_check"
    CHECK (("contract_id" IS NOT NULL AND "period_index" IS NOT NULL) OR "kind" IS NOT NULL);
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_kind_check"
    CHECK ("kind" IS NULL OR "kind" IN ('session', 'visit_fee', 'monthly'));
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_settled_by_check"
    CHECK ("settled_by" IS NULL OR "settled_by" IN ('payment', 'credit_note', 'cancellation'));
-- Avoirs : jamais au-delà du total ; la part imputée au reste dû en fait partie.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_credits_check"
    CHECK ("credited_amount" >= 0 AND "credited_amount" <= "credit_notes_total" AND "credit_notes_total" <= "total");

-- R-PE-01 : une seule facture mensuelle par organisation et par mois (émission idempotente, même
-- avec deux répliques de la tâche planifiée).
CREATE UNIQUE INDEX "invoices_monthly_organization_period_key"
    ON "invoices"("organization_id", "period_start") WHERE "kind" = 'monthly';

-- Séances à facturer : la recherche du passage du 1er ne lit que les séances non facturées.
CREATE INDEX "billable_sessions_unbilled_idx"
    ON "billable_sessions"("organization_id", "occurred_at") WHERE "invoice_id" IS NULL;

ALTER TABLE "billable_sessions" ADD CONSTRAINT "billable_sessions_amounts_check"
    CHECK ("amount_due" >= 0 AND "visit_fee_deduction" >= 0 AND "rank" >= 1 AND "sessions_count" >= "rank");
ALTER TABLE "billable_sessions" ADD CONSTRAINT "billable_sessions_kind_check"
    CHECK ("kind" IN ('session', 'missed_session', 'late_cancellation'));

ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_amounts_check"
    CHECK ("total" > 0 AND "applied_to_balance" >= 0 AND "credited_to_wallet" >= 0
        AND "applied_to_balance" + "credited_to_wallet" = "total");
