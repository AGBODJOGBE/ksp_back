-- Notifications « dans l'application » (lot 2 : messages des événements du Nettoyage).
-- Générée par « prisma migrate diff » depuis schema.prisma.

-- CreateTable
CREATE TABLE "in_app_notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "template_code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "source_event_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "read_at" TIMESTAMPTZ(3),

    CONSTRAINT "in_app_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "in_app_notifications_user_id_created_at_idx" ON "in_app_notifications"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "in_app_notifications_source_event_id_user_id_template_code_key" ON "in_app_notifications"("source_event_id", "user_id", "template_code");
