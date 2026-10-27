-- Comptes entreprise : organisations, membres, e-mail de facturation et journal d'audit (lot 2, ADR-027).
-- Générée par « prisma migrate diff » depuis schema.prisma, puis complétée à la main (index partiels,
-- en fin de fichier). Uniquement des ajouts.

-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('pending_review', 'active', 'rejected', 'suspended');

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('org_admin', 'org_member', 'org_viewer');

-- AlterTable
ALTER TABLE "email_verifications" ADD COLUMN     "organization_id" UUID;

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "legal_name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "ifu" TEXT NOT NULL,
    "rccm" TEXT,
    "billing_email" TEXT,
    "billing_email_verified_at" TIMESTAMPTZ(3),
    "status" "OrganizationStatus" NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "rejection_reason" TEXT,
    "suspended_by" UUID,
    "suspended_at" TIMESTAMPTZ(3),
    "suspension_reason" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_members" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "OrgRole" NOT NULL,
    "added_by" UUID,
    "joined_at" TIMESTAMPTZ(3) NOT NULL,
    "removed_at" TIMESTAMPTZ(3),

    CONSTRAINT "organization_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "details" JSONB,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "organizations_status_id_idx" ON "organizations"("status", "id");

-- CreateIndex
CREATE INDEX "organizations_created_by_status_idx" ON "organizations"("created_by", "status");

-- CreateIndex
CREATE INDEX "organization_members_user_id_removed_at_idx" ON "organization_members"("user_id", "removed_at");

-- CreateIndex
CREATE INDEX "organization_members_organization_id_idx" ON "organization_members"("organization_id");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "email_verifications_organization_id_created_at_idx" ON "email_verifications"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Écrit à la main : un IFU n'appartient qu'à une organisation non refusée (une demande refusée
-- peut être refaite).
CREATE UNIQUE INDEX "organizations_ifu_active_key" ON "organizations"("ifu") WHERE "status" <> 'rejected';

-- Écrit à la main : une seule appartenance active par compte et organisation.
CREATE UNIQUE INDEX "organization_members_active_key" ON "organization_members"("organization_id", "user_id") WHERE "removed_at" IS NULL;
