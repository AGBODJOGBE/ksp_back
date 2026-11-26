-- Contentieux (lot R5) : mise en demeure (délai et preuve de remise), devis des étapes payantes et
-- provisions du créancier (R-PR-04, ADR-060 point 10), référentiel des huissiers et avocats (R-HU-01),
-- assignations et actes (R-HU-02 à 07).

-- AlterTable
ALTER TABLE "notices" ADD COLUMN     "deadline_days" INTEGER,
ADD COLUMN     "deadline_at" TIMESTAMPTZ(3),
ADD COLUMN     "delivered_by" UUID;

-- AlterTable
ALTER TABLE "partners" ADD COLUMN     "verification_file_id" UUID,
ADD COLUMN     "status_reason" TEXT,
ADD COLUMN     "created_by" UUID;

-- AlterTable
ALTER TABLE "partner_assignments" ADD COLUMN     "note" TEXT,
ADD COLUMN     "completed_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "legal_acts" ADD COLUMN     "next_step_date" DATE;

-- AlterTable
ALTER TABLE "provisions" ADD COLUMN     "fee_quote_id" UUID;

-- CreateTable
CREATE TABLE "fee_quotes" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "decision_id" UUID NOT NULL,
    "stage" TEXT NOT NULL,
    "partner_id" UUID NOT NULL,
    "lines" JSONB NOT NULL,
    "total" INTEGER NOT NULL,
    "provision" INTEGER NOT NULL,
    "document_id" UUID NOT NULL,
    "document_number" TEXT NOT NULL,
    "valid_until" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "answered_at" TIMESTAMPTZ(3),

    CONSTRAINT "fee_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fee_quotes_case_id_idx" ON "fee_quotes"("case_id");

-- AddForeignKey
ALTER TABLE "fee_quotes" ADD CONSTRAINT "fee_quotes_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_quotes" ADD CONSTRAINT "fee_quotes_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "provisions_fee_quote_id_key" ON "provisions"("fee_quote_id");
