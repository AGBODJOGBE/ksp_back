-- Centre de notifications (ADR-038) : lecture des notifications de l'espace KSP, préférences de
-- canaux, historique des envois au back-office.

-- CreateTable
CREATE TABLE "notification_preferences" (
    "user_id" UUID NOT NULL,
    "whatsapp" BOOLEAN NOT NULL,
    "email" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE INDEX "notifications_created_at_id_idx" ON "notifications"("created_at" DESC, "id" DESC);

-- Écrit à la main (index partiel, que Prisma ne sait pas décrire) : nombre de non lues d'un compte.
CREATE INDEX "in_app_notifications_unread_idx" ON "in_app_notifications"("user_id") WHERE "read_at" IS NULL;
