-- Comptes, numéros de téléphone et codes de vérification (lot 1, UC-ID-01).
-- Générée par « prisma migrate diff » depuis schema.prisma.

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('pending_verification', 'active', 'locked', 'suspended', 'deletion_pending', 'deleted');

-- CreateEnum
CREATE TYPE "OtpChannel" AS ENUM ('sms', 'whatsapp');

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('login');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "status" "UserStatus" NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "preferred_language" TEXT NOT NULL DEFAULT 'fr',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deletion_requested_at" TIMESTAMPTZ(3),
    "anonymized_at" TIMESTAMPTZ(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_phones" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMPTZ(3),

    CONSTRAINT "user_phones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_challenges" (
    "id" UUID NOT NULL,
    "target" TEXT NOT NULL,
    "channel" "OtpChannel" NOT NULL,
    "channel_used" "OtpChannel",
    "purpose" "OtpPurpose" NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),
    "send_failed_at" TIMESTAMPTZ(3),

    CONSTRAINT "otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_phones_phone_e164_key" ON "user_phones"("phone_e164");

-- CreateIndex
CREATE INDEX "user_phones_user_id_idx" ON "user_phones"("user_id");

-- CreateIndex
CREATE INDEX "otp_challenges_target_sent_at_idx" ON "otp_challenges"("target", "sent_at");

-- AddForeignKey
ALTER TABLE "user_phones" ADD CONSTRAINT "user_phones_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

