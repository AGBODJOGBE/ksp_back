-- Notifications envoyées directement (SendNotification, lot 1 : codes de connexion).
-- Générée par « prisma migrate diff » depuis schema.prisma. Aucune colonne pour le texte ni les variables (ADR-014).

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('sms', 'whatsapp', 'email', 'push', 'in_app');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('pending', 'accepted', 'failed');

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "template_code" TEXT NOT NULL,
    "requested_channel" "NotificationChannel" NOT NULL,
    "channel_used" "NotificationChannel",
    "channels_tried" "NotificationChannel"[] DEFAULT ARRAY[]::"NotificationChannel"[],
    "target_masked" TEXT NOT NULL,
    "recipient_user_id" UUID,
    "status" "NotificationStatus" NOT NULL,
    "provider_message_id" TEXT,
    "error_code" TEXT,
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3),
    "accepted_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_idempotency_key_key" ON "notifications"("idempotency_key");

