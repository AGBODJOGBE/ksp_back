-- Recouvrement — facture mensuelle de commission par créancier et reçus des frais de dossier
-- (ADR-060 décision 11, R-CO-05 ; ADR-064). Migration additive : aucune table existante ne change.
--
-- Encaissements appris par recovery.payment.collected (un par encaissement) ; facture de commission
-- (une par créancier et par mois, hors taxe) et ses lignes figées ; reçus des débits de frais faits
-- par recovery (wallet.prepaid.debited), un par transaction du portefeuille ; compteurs des séries
-- FCR et RFD, par année, distincts de ceux des factures (FAC) et des avoirs (AV). Identifiants et
-- montants seulement : aucune donnée du débiteur.

-- CreateTable
CREATE TABLE "commission_collections" (
    "collection_id" UUID NOT NULL,
    "creditor_type" TEXT NOT NULL,
    "creditor_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "case_number" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "gross" INTEGER NOT NULL,
    "commission" INTEGER NOT NULL,
    "settlement" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "invoice_id" UUID,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "commission_collections_pkey" PRIMARY KEY ("collection_id")
);

-- CreateTable
CREATE TABLE "commission_invoices" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "creditor_type" TEXT NOT NULL,
    "creditor_id" UUID NOT NULL,
    "period_start" TIMESTAMPTZ(3) NOT NULL,
    "period_end" TIMESTAMPTZ(3) NOT NULL,
    "total_collected" INTEGER NOT NULL,
    "commission_deducted" INTEGER NOT NULL,
    "commission_invoiced" INTEGER NOT NULL,
    "commission_total" INTEGER NOT NULL,
    "organization_legal_name" TEXT,
    "organization_address" TEXT,
    "organization_ifu" TEXT,
    "organization_rccm" TEXT,
    "issued_at" TIMESTAMPTZ(3) NOT NULL,
    "paid_at" TIMESTAMPTZ(3),
    "wallet_transaction_id" TEXT,
    "debit_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_debit_attempt_at" TIMESTAMPTZ(3),
    "next_debit_attempt_at" TIMESTAMPTZ(3),
    "last_debit_failure" TEXT,
    "debit_missing_amount" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "commission_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_invoice_lines" (
    "invoice_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "collection_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "case_number" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "source" TEXT NOT NULL,
    "gross" INTEGER NOT NULL,
    "commission" INTEGER NOT NULL,
    "settlement" TEXT NOT NULL,

    CONSTRAINT "commission_invoice_lines_pkey" PRIMARY KEY ("invoice_id","position")
);

-- CreateTable
CREATE TABLE "fee_receipts" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "wallet_transaction_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "payer_type" TEXT NOT NULL,
    "payer_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "case_number" TEXT,
    "label" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "paid_at" TIMESTAMPTZ(3) NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fee_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "series_counters" (
    "series" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "last_number" INTEGER NOT NULL,

    CONSTRAINT "series_counters_pkey" PRIMARY KEY ("series","year")
);

-- CreateIndex
CREATE INDEX "commission_collections_creditor_type_creditor_id_received_a_idx" ON "commission_collections"("creditor_type", "creditor_id", "received_at");

-- CreateIndex
CREATE INDEX "commission_collections_invoice_id_idx" ON "commission_collections"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "commission_invoices_number_key" ON "commission_invoices"("number");

-- CreateIndex
CREATE INDEX "commission_invoices_creditor_type_creditor_id_id_idx" ON "commission_invoices"("creditor_type", "creditor_id", "id");

-- CreateIndex
CREATE INDEX "commission_invoices_status_next_debit_attempt_at_idx" ON "commission_invoices"("status", "next_debit_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "commission_invoices_creditor_type_creditor_id_period_start_key" ON "commission_invoices"("creditor_type", "creditor_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "commission_invoice_lines_collection_id_key" ON "commission_invoice_lines"("collection_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_receipts_number_key" ON "fee_receipts"("number");

-- CreateIndex
CREATE UNIQUE INDEX "fee_receipts_wallet_transaction_id_key" ON "fee_receipts"("wallet_transaction_id");

-- CreateIndex
CREATE INDEX "fee_receipts_payer_type_payer_id_id_idx" ON "fee_receipts"("payer_type", "payer_id", "id");

-- AddForeignKey
ALTER TABLE "commission_collections" ADD CONSTRAINT "commission_collections_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "commission_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_invoice_lines" ADD CONSTRAINT "commission_invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "commission_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "commission_collections" ADD CONSTRAINT "commission_collections_values_check"
    CHECK ("creditor_type" IN ('user', 'organization') AND "settlement" IN ('deducted', 'invoiced')
        AND "source" IN ('payment_link', 'offline_cash', 'offline_transfer', 'partner', 'direct_to_creditor'));
ALTER TABLE "commission_collections" ADD CONSTRAINT "commission_collections_amounts_check"
    CHECK ("gross" > 0 AND "commission" >= 0);
-- Encaissements à facturer : la recherche du passage du 1er ne lit que les encaissements non facturés.
CREATE INDEX "commission_collections_unbilled_idx"
    ON "commission_collections"("received_at") WHERE "invoice_id" IS NULL;

ALTER TABLE "commission_invoices" ADD CONSTRAINT "commission_invoices_values_check"
    CHECK ("status" IN ('pending_payment', 'paid', 'cancelled') AND "creditor_type" IN ('user', 'organization')
        AND ("last_debit_failure" IS NULL OR "last_debit_failure" IN ('insufficient_funds', 'wallet_error')));
-- Totaux hors taxe : commission totale = retenue + à débiter ; une facture payée a sa date de règlement.
ALTER TABLE "commission_invoices" ADD CONSTRAINT "commission_invoices_amounts_check"
    CHECK ("total_collected" > 0 AND "commission_deducted" >= 0 AND "commission_invoiced" >= 0
        AND "commission_total" = "commission_deducted" + "commission_invoiced"
        AND ("status" <> 'paid' OR "paid_at" IS NOT NULL)
        AND "debit_attempts" >= 0 AND ("debit_missing_amount" IS NULL OR "debit_missing_amount" > 0));
-- En-tête figé seulement pour une organisation créancière.
ALTER TABLE "commission_invoices" ADD CONSTRAINT "commission_invoices_header_check"
    CHECK ("creditor_type" = 'organization' OR "organization_legal_name" IS NULL);

ALTER TABLE "commission_invoice_lines" ADD CONSTRAINT "commission_invoice_lines_values_check"
    CHECK ("position" >= 1 AND "gross" > 0 AND "commission" >= 0 AND "settlement" IN ('deducted', 'invoiced'));

ALTER TABLE "fee_receipts" ADD CONSTRAINT "fee_receipts_values_check"
    CHECK ("kind" IN ('case_fee', 'study_fee') AND "payer_type" IN ('user', 'organization') AND "amount" > 0);

ALTER TABLE "series_counters" ADD CONSTRAINT "series_counters_values_check"
    CHECK ("series" IN ('FCR', 'RFD') AND "last_number" >= 1);
