-- ADR-038 : fichiers stockés (métadonnées ; le contenu vit dans le stockage objet compatible S3).

-- CreateTable
CREATE TABLE "files" (
    "id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "rejection_reason" TEXT,
    "owner_id" UUID,
    "subject_type" TEXT,
    "subject_id" TEXT,
    "attached_by" TEXT,
    "attached_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "deletion_reason" TEXT,
    "erase_after" TIMESTAMPTZ(3),

    CONSTRAINT "files_pkey" PRIMARY KEY ("id"),
    -- Garde-fous écrits à la main (non exprimables dans schema.prisma).
    CONSTRAINT "files_status_check" CHECK ("status" IN ('pending', 'available', 'rejected', 'deleted')),
    CONSTRAINT "files_size_check" CHECK ("size_bytes" > 0),
    CONSTRAINT "files_subject_check" CHECK (("subject_type" IS NULL) = ("subject_id" IS NULL)),
    CONSTRAINT "files_rejection_check" CHECK (("status" = 'rejected') = ("rejection_reason" IS NOT NULL))
);

-- CreateIndex
CREATE UNIQUE INDEX "files_storage_key_key" ON "files"("storage_key");

-- CreateIndex : quotas par compte (envois en attente, volume sur 24 heures).
CREATE INDEX "files_owner_id_created_at_idx" ON "files"("owner_id", "created_at");

-- CreateIndex : fichiers d'un objet métier.
CREATE INDEX "files_subject_type_subject_id_idx" ON "files"("subject_type", "subject_id");

-- Purge (index partiels, non exprimables dans schema.prisma) : envois non confirmés, fichiers
-- jamais rattachés, effacements physiques dus.
CREATE INDEX "files_pending_idx" ON "files"("created_at") WHERE "status" = 'pending';
CREATE INDEX "files_unattached_idx" ON "files"("completed_at") WHERE "status" = 'available' AND "subject_id" IS NULL;
CREATE INDEX "files_erase_idx" ON "files"("erase_after") WHERE "erase_after" IS NOT NULL;
