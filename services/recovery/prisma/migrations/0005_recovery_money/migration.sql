-- Argent et espace du débiteur (lot R3) : clôture du dossier et ses effets (attestation de solde,
-- liens révoqués), encaissements (étape, commission retenue ou facturée, reçu, paiement direct),
-- paiements hors ligne (preuve, note, partenaire déclarant), liens de paiement demandés par le
-- débiteur, contestations (pièces, suite), demandes de rappel, trop-perçus remboursés par la finance.

-- AlterTable
ALTER TABLE "recovery_cases" ADD COLUMN     "closed_by_id" UUID,
ADD COLUMN     "closed_by_type" TEXT,
ADD COLUMN     "closure_completed_at" TIMESTAMPTZ(3),
ADD COLUMN     "closure_note" TEXT,
ADD COLUMN     "settlement_certificate_document_id" UUID;

-- AlterTable
ALTER TABLE "payment_requests" ADD COLUMN     "debtor_id" UUID,
ADD COLUMN     "idempotency_key" TEXT,
ADD COLUMN     "payment_url" TEXT,
ADD COLUMN     "settlement_id" UUID;

-- AlterTable
ALTER TABLE "collections" ADD COLUMN     "commission_settlement" TEXT NOT NULL DEFAULT 'deducted',
ADD COLUMN     "due_before" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "proof_file_id" UUID,
ADD COLUMN     "receipt_document_id" UUID,
ADD COLUMN     "receipt_method" TEXT,
ADD COLUMN     "receipt_reference" TEXT,
ADD COLUMN     "recorded_by" UUID,
ADD COLUMN     "stage" TEXT;

-- AlterTable
ALTER TABLE "offline_payments" ADD COLUMN     "note" TEXT,
ADD COLUMN     "partner_assignment_id" UUID,
ADD COLUMN     "proof_file_id" UUID;

-- AlterTable
ALTER TABLE "disputes" ADD COLUMN     "debtor_id" UUID,
ADD COLUMN     "file_ids" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "idempotency_key" TEXT,
ADD COLUMN     "resolution_note" TEXT;

-- AlterTable
ALTER TABLE "callback_requests" ADD COLUMN     "debtor_id" UUID,
ADD COLUMN     "note_enc" TEXT;

-- CreateTable
CREATE TABLE "overpayment_refunds" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "note" TEXT,
    "recorded_by" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "overpayment_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "overpayment_refunds_case_id_idx" ON "overpayment_refunds"("case_id");

-- CreateIndex
CREATE UNIQUE INDEX "overpayment_refunds_recorded_by_idempotency_key_key" ON "overpayment_refunds"("recorded_by", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "payment_requests_case_id_idempotency_key_key" ON "payment_requests"("case_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "offline_payments_case_id_created_at_idx" ON "offline_payments"("case_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "disputes_case_id_idempotency_key_key" ON "disputes"("case_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "callback_requests_case_id_created_at_idx" ON "callback_requests"("case_id", "created_at");

-- AddForeignKey
ALTER TABLE "overpayment_refunds" ADD CONSTRAINT "overpayment_refunds_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
