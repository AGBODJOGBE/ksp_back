-- Procédure amiable (lot R4) : rappel promis et pièce d'un contact, note et constat d'une promesse non
-- tenue, protocole d'échéancier en cours de signature (envois, validation du superviseur, verrou
-- optimiste), remises pour paiement immédiat (R-PR-05) et file des messages au débiteur (premier
-- contact, relances, rappels d'échéance), envoyés dans la plage de contact.

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "callback_at" TIMESTAMPTZ(3),
ADD COLUMN     "callback_done_at" TIMESTAMPTZ(3),
ADD COLUMN     "debtor_id" UUID,
ADD COLUMN     "file_id" UUID;

-- AlterTable
ALTER TABLE "payment_promises" ADD COLUMN     "broken_at" TIMESTAMPTZ(3),
ADD COLUMN     "note" TEXT;

-- AlterTable
ALTER TABLE "payment_plans" ADD COLUMN     "document_id" UUID,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "reviewed_at" TIMESTAMPTZ(3),
ADD COLUMN     "reviewed_by" UUID,
ADD COLUMN     "signature_expires_at" TIMESTAMPTZ(3),
ADD COLUMN     "signature_round" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "signature_sent_at" TIMESTAMPTZ(3),
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "settlements" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "pay_now" INTEGER NOT NULL,
    "waived" INTEGER NOT NULL,
    "discount_bps" INTEGER NOT NULL,
    "valid_until" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "within_scale" BOOLEAN NOT NULL,
    "proposed_by" UUID NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "answered_at" TIMESTAMPTZ(3),

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debtor_messages" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "debtor_id" UUID NOT NULL,
    "message" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "variables" JSONB NOT NULL,
    "ref_id" UUID,
    "channel" TEXT,
    "not_before" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "notification_id" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "debtor_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "settlements_case_id_status_idx" ON "settlements"("case_id", "status");

-- CreateIndex
CREATE INDEX "settlements_status_valid_until_idx" ON "settlements"("status", "valid_until");

-- CreateIndex
CREATE UNIQUE INDEX "debtor_messages_dedupe_key_key" ON "debtor_messages"("dedupe_key");

-- CreateIndex
CREATE INDEX "debtor_messages_status_not_before_idx" ON "debtor_messages"("status", "not_before");

-- CreateIndex
CREATE INDEX "debtor_messages_case_id_purpose_idx" ON "debtor_messages"("case_id", "purpose");

-- CreateIndex
CREATE INDEX "contacts_callback_at_idx" ON "contacts"("callback_at");

-- CreateIndex
CREATE INDEX "payment_plans_document_id_idx" ON "payment_plans"("document_id");

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debtor_messages" ADD CONSTRAINT "debtor_messages_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Un seul échéancier en cours d'accord et un seul échéancier signé en cours par dossier, une seule
-- remise ouverte (index partiels, non exprimables dans schema.prisma).
CREATE UNIQUE INDEX "payment_plans_one_pending_idx" ON "payment_plans"("case_id")
  WHERE "status" IN ('proposed', 'pending_creditor');
CREATE UNIQUE INDEX "payment_plans_one_signed_idx" ON "payment_plans"("case_id")
  WHERE "status" = 'signed';
CREATE UNIQUE INDEX "settlements_one_open_idx" ON "settlements"("case_id")
  WHERE "status" IN ('proposed', 'pending_creditor', 'accepted');
