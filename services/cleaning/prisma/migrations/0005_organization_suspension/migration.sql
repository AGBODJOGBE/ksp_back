-- Suspension d'une organisation par KSP : ses missions sont suspendues avec elle, et reprennent à
-- sa réactivation (ADR-030). Migration additive.

-- Causes de suspension cumulables (impayés, organisation suspendue) ; suspension_cause garde la
-- plus ancienne cause active. Reprise des suspensions en cours : leur cause unique.
ALTER TABLE "missions" ADD COLUMN "suspension_causes" TEXT[] DEFAULT ARRAY[]::TEXT[];
UPDATE "missions" SET "suspension_causes" = ARRAY["suspension_cause"] WHERE "suspension_cause" IS NOT NULL;

-- Missions d'une organisation, à suspendre ou reprendre avec elle.
CREATE INDEX "missions_organization_id_idx" ON "missions"("organization_id");

-- État des organisations appris par identity.organization.suspended et .reactivated.
CREATE TABLE "organization_standings" (
    "organization_id" UUID NOT NULL,
    "suspended" BOOLEAN NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organization_standings_pkey" PRIMARY KEY ("organization_id")
);
