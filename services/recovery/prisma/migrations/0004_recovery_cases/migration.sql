-- Dossiers du recouvrement (lot R2) : mandat et frais (forfait d'étude figé, débit rapproché,
-- remboursement d'un dossier refusé), examen de recevabilité, dernière action, recherche d'un débiteur
-- par l'empreinte des mots de son nom, imports (offre, archive, verrou), journal de preuve (nature,
-- sens, montant) et préférences des créanciers.

-- AlterTable
ALTER TABLE "recovery_cases" ADD COLUMN     "assessment_key" TEXT,
ADD COLUMN     "completion_note" TEXT,
ADD COLUMN     "fee_debit_attempted_at" TIMESTAMPTZ(3),
ADD COLUMN     "fee_refund_transaction_id" UUID,
ADD COLUMN     "fee_refunded_at" TIMESTAMPTZ(3),
ADD COLUMN     "info_requested_at" TIMESTAMPTZ(3),
ADD COLUMN     "last_action_at" TIMESTAMPTZ(3),
ADD COLUMN     "mandate_signature_id" UUID,
ADD COLUMN     "review_note" TEXT,
ADD COLUMN     "study_fee" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "study_fee_charged_at" TIMESTAMPTZ(3),
ADD COLUMN     "study_fee_rule_id" UUID,
ADD COLUMN     "study_fee_rule_version" INTEGER,
ADD COLUMN     "study_fee_transaction_id" UUID;

-- AlterTable
ALTER TABLE "debtors" ADD COLUMN     "name_tokens" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "case_imports" ADD COLUMN     "evidence_archive_file_id" UUID,
ADD COLUMN     "kind" "CaseKind" NOT NULL DEFAULT 'b2b',
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "status" SET DEFAULT 'checked';

-- AlterTable : colonnes ajoutées sans valeur par défaut, aucune ligne réécrite (journal en ajout seul).
ALTER TABLE "evidence_entries" ADD COLUMN     "amount" INTEGER,
ADD COLUMN     "direction" TEXT,
ADD COLUMN     "kind" TEXT;

-- CreateTable
CREATE TABLE "creditor_preferences" (
    "creditor_type" "PartyType" NOT NULL,
    "creditor_id" UUID NOT NULL,
    "b2b_scale" JSONB,
    "b2c_scale" JSONB,
    "notify_user_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "creditor_preferences_pkey" PRIMARY KEY ("creditor_type","creditor_id")
);

-- CreateIndex
CREATE INDEX "recovery_cases_status_created_at_idx" ON "recovery_cases"("status", "created_at");

-- CreateIndex
CREATE INDEX "recovery_cases_status_info_requested_at_idx" ON "recovery_cases"("status", "info_requested_at");

-- CreateIndex
CREATE INDEX "debtors_name_tokens_idx" ON "debtors" USING GIN ("name_tokens");
