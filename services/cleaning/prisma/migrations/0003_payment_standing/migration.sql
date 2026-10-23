-- Règles de paiement, d'avertissement, de suspension et de reprise, zones desservies
-- (CDC Nettoyage, partie 10, et décisions du 2026-10-23).

-- Réglages de l'admin (valeurs par défaut du cahier des charges).
ALTER TABLE "cleaning_settings"
    ADD COLUMN "business_warning_unpaid_invoices" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "business_suspension_unpaid_invoices" INTEGER NOT NULL DEFAULT 2,
    ADD COLUMN "individual_suspension_unpaid_interventions" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "individual_payment_grace_hours" INTEGER NOT NULL DEFAULT 24;

-- Entreprise : jours d'intervention par semaine.
ALTER TABLE "quote_requests" ADD COLUMN "days_per_week" INTEGER;

-- Suspension en cours et dernier avertissement.
ALTER TABLE "missions"
    ADD COLUMN "days_per_week" INTEGER,
    ADD COLUMN "suspension_cause" TEXT,
    ADD COLUMN "suspended_since" TIMESTAMPTZ(3),
    ADD COLUMN "suspension_unpaid_count" INTEGER,
    ADD COLUMN "warning_level" INTEGER NOT NULL DEFAULT 0;

-- Cause de l'annulation d'un passage : une suspension se reprogramme au déblocage.
ALTER TABLE "interventions"
    ADD COLUMN "cancellation_cause" TEXT,
    ADD COLUMN "cancelled_at" TIMESTAMPTZ(3);

-- Factures d'entreprise impayées ou réglées, apprises par les événements de billing.
CREATE TABLE "contract_invoices" (
    "invoice_id" UUID NOT NULL,
    "mission_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "contract_invoices_pkey" PRIMARY KEY ("invoice_id")
);

CREATE INDEX "contract_invoices_mission_id_status_idx" ON "contract_invoices"("mission_id", "status");


-- Zones desservies : au départ Cotonou, Porto-Novo et Abomey-Calavi (clé = commune normalisée).
CREATE TABLE "service_zones" (
    "code" TEXT NOT NULL,
    "commune" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,
    "updated_at" TIMESTAMPTZ(3),

    CONSTRAINT "service_zones_pkey" PRIMARY KEY ("code")
);

INSERT INTO "service_zones" ("code", "commune") VALUES
    ('cotonou', 'Cotonou'),
    ('porto-novo', 'Porto-Novo'),
    ('abomey-calavi', 'Abomey-Calavi');
