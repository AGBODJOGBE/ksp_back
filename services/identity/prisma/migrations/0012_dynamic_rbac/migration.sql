-- RBAC dynamique (CDC Nettoyage v2, partie 2, R-RB-01 à 06 ; ADR-057) : permissions déclarées par
-- le code des services, rôles créés et modifiés au back-office, portée zone d'une attribution.
-- Écrite à la main d'après schema.prisma ; des ajouts seulement, plus le nom affiché des rôles déjà
-- en base, qui deviennent des rôles livrés par défaut sans permission cochée.

-- Portée zone : attribution limitée à des communes (R-RB-03). La nouvelle valeur n'est jamais
-- comparée telle quelle dans ce fichier (texte seulement), pour rester dans une seule transaction.
ALTER TYPE "RoleScopeType" ADD VALUE IF NOT EXISTS 'zone';

-- Rôles gérés (R-RB-02).
ALTER TABLE "roles"
    ADD COLUMN "name" TEXT,
    ADD COLUMN "sensitive" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'default',
    ADD COLUMN "created_by" UUID,
    ADD COLUMN "updated_at" TIMESTAMPTZ(3),
    ADD COLUMN "updated_by" UUID,
    ADD COLUMN "deactivated_at" TIMESTAMPTZ(3),
    ADD COLUMN "deactivated_by" UUID;
ALTER TABLE "roles" ADD CONSTRAINT "roles_origin_check" CHECK ("origin" IN ('default', 'custom'));

-- Permissions déclarées par les services (R-RB-01).
CREATE TABLE "permissions" (
    "code" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "registered_at" TIMESTAMPTZ(3) NOT NULL,
    "retired_at" TIMESTAMPTZ(3),

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("code"),
    CONSTRAINT "permissions_code_format" CHECK ("code" ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
    -- Le premier segment du code est toujours le service qui la déclare.
    CONSTRAINT "permissions_service_prefix" CHECK (split_part("code", '.', 1) = "service")
);
CREATE INDEX "permissions_service_idx" ON "permissions"("service");

CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_code" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id", "permission_code")
);
CREATE INDEX "role_permissions_permission_code_idx" ON "role_permissions"("permission_code");
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_code_fkey" FOREIGN KEY ("permission_code") REFERENCES "permissions"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Version de catalogue déjà enregistrée par service : RegisterCatalog rejoué est sans effet.
CREATE TABLE "catalog_registrations" (
    "service" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "registered_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "catalog_registrations_pkey" PRIMARY KEY ("service")
);

-- Zones d'une attribution, triées : présentes pour la portée zone seulement.
ALTER TABLE "role_assignments" ADD COLUMN "zone_keys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_zone_keys_check"
    CHECK (("scope_type"::TEXT = 'zone') = (cardinality("zone_keys") > 0));

-- Une seule attribution active par compte, rôle, portée et ensemble de zones.
DROP INDEX "role_assignments_active_key";
CREATE UNIQUE INDEX "role_assignments_active_key" ON "role_assignments"("user_id", "role_id", COALESCE("scope_id", ''), "zone_keys") WHERE "revoked_at" IS NULL;

-- Noms affichés des rôles livrés par défaut (R-RB-02) ; super_admin est sensible (R-RB-05).
UPDATE "roles" SET "name" = 'Super administrateur', "sensitive" = true WHERE "code" = 'super_admin';
UPDATE "roles" SET "name" = 'Finance', "sensitive" = true WHERE "code" = 'finance_officer';
UPDATE "roles" SET "name" = 'Support' WHERE "code" = 'support_agent';
UPDATE "roles" SET "name" = 'Administrateur Nettoyage' WHERE "code" = 'cleaning_admin';
UPDATE "roles" SET "name" = 'Superviseur Nettoyage' WHERE "code" = 'cleaning_supervisor';
UPDATE "roles" SET "name" = 'Agent de nettoyage' WHERE "code" = 'cleaning_agent';
