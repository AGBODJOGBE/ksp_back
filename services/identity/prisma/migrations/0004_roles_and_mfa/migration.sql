-- Rôles du back-office et double authentification (lot 2, UC-ID-09 ; ADR-023).
-- Générée par « prisma migrate diff » depuis schema.prisma, puis complétée à la main
-- (contrainte, index partiel et catalogue initial, en fin de fichier).

-- CreateEnum
CREATE TYPE "RoleScopeType" AS ENUM ('global', 'domain', 'org', 'personal');

-- CreateEnum
CREATE TYPE "MfaFactorType" AS ENUM ('totp', 'sms');

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "mfa_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "service" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "scope_type" "RoleScopeType" NOT NULL,
    "requires_mfa" BOOLEAN NOT NULL,
    "backoffice_access" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_assignments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "scope_type" "RoleScopeType" NOT NULL,
    "scope_id" TEXT,
    "granted_by" UUID,
    "granted_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_factors" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "MfaFactorType" NOT NULL,
    "secret_encrypted" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "enabled_at" TIMESTAMPTZ(3),
    "last_used_step" INTEGER,
    "last_used_at" TIMESTAMPTZ(3),

    CONSTRAINT "mfa_factors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_recovery_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),

    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_challenges" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "client_kind" "ClientKind" NOT NULL,
    "device_label" TEXT,
    "ip" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),

    CONSTRAINT "mfa_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");

-- CreateIndex
CREATE INDEX "role_assignments_user_id_revoked_at_idx" ON "role_assignments"("user_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_factors_user_id_type_key" ON "mfa_factors"("user_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_recovery_codes_code_hash_key" ON "mfa_recovery_codes"("code_hash");

-- CreateIndex
CREATE INDEX "mfa_recovery_codes_user_id_idx" ON "mfa_recovery_codes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_challenges_token_hash_key" ON "mfa_challenges"("token_hash");

-- CreateIndex
CREATE INDEX "mfa_challenges_user_id_idx" ON "mfa_challenges"("user_id");

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_factors" ADD CONSTRAINT "mfa_factors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_challenges" ADD CONSTRAINT "mfa_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Écrit à la main : tout rôle qui donne accès au back-office exige la double authentification
-- (cahier des charges Identité, partie 5).
ALTER TABLE "roles" ADD CONSTRAINT "roles_backoffice_requires_mfa" CHECK (NOT "backoffice_access" OR "requires_mfa");

-- Écrit à la main : une seule attribution active par compte, rôle et portée.
CREATE UNIQUE INDEX "role_assignments_active_key" ON "role_assignments"("user_id", "role_id", COALESCE("scope_id", '')) WHERE "revoked_at" IS NULL;

-- Écrit à la main : catalogue initial du back-office (INITIAL_BACKOFFICE_ROLES dans src/domain/role/role.ts).
INSERT INTO "roles" ("id", "service", "code", "scope_type", "requires_mfa", "backoffice_access", "description") VALUES
    ('019a0000-0000-7000-8000-000000000001', 'identity', 'super_admin', 'global', true, true, 'Direction KSP : tout l’écosystème, y compris les admins métier'),
    ('019a0000-0000-7000-8000-000000000002', 'identity', 'support_agent', 'global', true, true, 'Support client : consultation des comptes et des dossiers'),
    ('019a0000-0000-7000-8000-000000000003', 'wallet', 'finance_officer', 'domain', true, true, 'Validation des versements'),
    ('019a0000-0000-7000-8000-000000000004', 'cleaning', 'cleaning_admin', 'domain', true, true, 'Responsable du métier Nettoyage'),
    ('019a0000-0000-7000-8000-000000000005', 'cleaning', 'cleaning_supervisor', 'domain', true, true, 'Superviseur des missions de nettoyage'),
    ('019a0000-0000-7000-8000-000000000006', 'cleaning', 'cleaning_agent', 'domain', true, true, 'Agent de terrain du nettoyage'),
    ('019a0000-0000-7000-8000-000000000007', 'recovery', 'recovery_admin', 'domain', true, true, 'Responsable du métier Recouvrement'),
    ('019a0000-0000-7000-8000-000000000008', 'recovery', 'recovery_agent', 'domain', true, true, 'Agent de recouvrement');
