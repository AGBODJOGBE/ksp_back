-- Relevés mensuels par dossier (R-CO-05, ADR-060 point 11) : encaissements crédités au créancier
-- pendant le mois, commission, frais retenus et net reversé, avec leur PDF ; factures mensuelles de
-- commission émises par billing (ADR-064), rattachées aux relevés du même créancier et du même mois.

-- CreateTable
CREATE TABLE "statements" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "creditor_type" "PartyType" NOT NULL,
    "creditor_id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "collected" INTEGER NOT NULL,
    "commission" INTEGER NOT NULL,
    "costs" INTEGER NOT NULL,
    "remitted" INTEGER NOT NULL,
    "document_id" UUID NOT NULL,
    "document_number" TEXT NOT NULL,
    "invoice_id" UUID,
    "issued_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_invoices" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "creditor_type" "PartyType" NOT NULL,
    "creditor_id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commission_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "statements_creditor_type_creditor_id_period_idx" ON "statements"("creditor_type", "creditor_id", "period");

-- CreateIndex
CREATE UNIQUE INDEX "statements_case_id_period_key" ON "statements"("case_id", "period");

-- CreateIndex
CREATE UNIQUE INDEX "commission_invoices_creditor_type_creditor_id_period_key" ON "commission_invoices"("creditor_type", "creditor_id", "period");

-- AddForeignKey
ALTER TABLE "statements" ADD CONSTRAINT "statements_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
