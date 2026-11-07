-- Administration des comptes et des rôles au back-office (ADR-038, UC-ID-18 à 20).
-- Générée par « prisma migrate diff » depuis schema.prisma. Colonnes ajoutées, toutes facultatives :
-- aucune ligne existante à reprendre.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "suspended_at" TIMESTAMPTZ(3),
ADD COLUMN     "suspended_by" UUID,
ADD COLUMN     "suspension_reason" TEXT;

-- AlterTable
ALTER TABLE "role_assignments" ADD COLUMN     "grant_reason" TEXT,
ADD COLUMN     "revoke_reason" TEXT,
ADD COLUMN     "revoked_by" UUID;

-- CreateIndex
CREATE INDEX "role_assignments_role_id_revoked_at_idx" ON "role_assignments"("role_id", "revoked_at");
