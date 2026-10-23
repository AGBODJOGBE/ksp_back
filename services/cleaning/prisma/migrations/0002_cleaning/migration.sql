-- Service Nettoyage (lot 2) : catalogue et grille versionnée, réglages, demandes, visites, devis,
-- missions et passages, paiements, agents et équipes, traces locales.
-- Générée par « prisma migrate diff » depuis schema.prisma, complétée à la main en fin de fichier.
-- La grille est vide : les prix sont saisis au back-office par l'équipe Nettoyage.

-- CreateTable
CREATE TABLE "cleaning_services" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "unit" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cleaning_services_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "pricing_rules" (
    "id" UUID NOT NULL,
    "service_code" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "unit_price" INTEGER,
    "minimum_price" INTEGER,
    "options" JSONB NOT NULL DEFAULT '[]',
    "commune_coefficients" JSONB NOT NULL DEFAULT '{}',
    "default_coefficient_bp" INTEGER NOT NULL DEFAULT 10000,
    "team_size" JSONB NOT NULL,
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pricing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cleaning_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "quote_validity_days" INTEGER NOT NULL DEFAULT 15,
    "minimum_lead_hours" INTEGER NOT NULL DEFAULT 48,
    "free_cancellation_hours" INTEGER NOT NULL DEFAULT 24,
    "visit_threshold_square_meters" INTEGER NOT NULL DEFAULT 300,
    "max_open_requests" INTEGER NOT NULL DEFAULT 5,
    "deposit_percent" INTEGER NOT NULL DEFAULT 30,
    "updated_by" TEXT,
    "updated_at" TIMESTAMPTZ(3),

    CONSTRAINT "cleaning_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_requests" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "customer_kind" TEXT NOT NULL,
    "organization_id" UUID,
    "service_code" TEXT NOT NULL,
    "premises_type" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "options" TEXT[],
    "commune" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "preferred_slots" JSONB NOT NULL,
    "comment" TEXT,
    "recurrence" JSONB,
    "requested_team_size" INTEGER NOT NULL DEFAULT 0,
    "recommended_team_size" INTEGER NOT NULL,
    "estimate_low" INTEGER,
    "estimate_high" INTEGER,
    "current_quote_id" UUID,
    "mission_id" UUID,
    "closing_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "quote_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_visits" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "scheduled_at" TIMESTAMPTZ(3) NOT NULL,
    "agent_id" UUID NOT NULL,
    "report" TEXT,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "site_visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "lines" JSONB NOT NULL,
    "subtotal" INTEGER NOT NULL,
    "intervention_count" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "proposed_slots" JSONB NOT NULL,
    "valid_until" TIMESTAMPTZ(3) NOT NULL,
    "deposit_percent" INTEGER NOT NULL,
    "deposit_amount" INTEGER NOT NULL,
    "recurrence" JSONB,
    "team_size" INTEGER NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "sent_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "missions" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "acceptance_key" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "organization_id" UUID,
    "status" TEXT NOT NULL,
    "service_code" TEXT NOT NULL,
    "commune" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "chosen_slot_start" TIMESTAMPTZ(3) NOT NULL,
    "chosen_slot_end" TIMESTAMPTZ(3) NOT NULL,
    "recurrence" JSONB,
    "planned_interventions" INTEGER NOT NULL,
    "payment_plan" JSONB NOT NULL,
    "payment_total" INTEGER NOT NULL,
    "deposit_percent" INTEGER NOT NULL,
    "deposit_amount" INTEGER NOT NULL,
    "cancellation_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "missions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interventions" (
    "id" UUID NOT NULL,
    "mission_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "scheduled_start" TIMESTAMPTZ(3) NOT NULL,
    "scheduled_end" TIMESTAMPTZ(3) NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "agent_ids" UUID[],
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "incident_note" TEXT,
    "before_photo_file_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "after_photo_file_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "interventions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mission_payments" (
    "id" UUID NOT NULL,
    "mission_id" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "recorded_by" TEXT NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mission_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agents" (
    "user_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "agent_unavailabilities" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT,

    CONSTRAINT "agent_unavailabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "team_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("team_id","agent_id")
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
CREATE UNIQUE INDEX "pricing_rules_service_code_version_key" ON "pricing_rules"("service_code", "version");

-- CreateIndex
CREATE INDEX "quote_requests_customer_id_id_idx" ON "quote_requests"("customer_id", "id");

-- CreateIndex
CREATE INDEX "quote_requests_status_id_idx" ON "quote_requests"("status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "quote_requests_customer_id_idempotency_key_key" ON "quote_requests"("customer_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "site_visits_request_id_key" ON "site_visits"("request_id");

-- CreateIndex
CREATE INDEX "quotes_request_id_idx" ON "quotes"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "missions_request_id_key" ON "missions"("request_id");

-- CreateIndex
CREATE INDEX "missions_customer_id_id_idx" ON "missions"("customer_id", "id");

-- CreateIndex
CREATE INDEX "missions_status_id_idx" ON "missions"("status", "id");

-- CreateIndex
CREATE INDEX "interventions_mission_id_idx" ON "interventions"("mission_id");

-- CreateIndex
CREATE INDEX "interventions_scheduled_start_scheduled_end_idx" ON "interventions"("scheduled_start", "scheduled_end");

-- CreateIndex
CREATE INDEX "mission_payments_mission_id_idx" ON "mission_payments"("mission_id");

-- CreateIndex
CREATE INDEX "agent_unavailabilities_agent_id_starts_at_idx" ON "agent_unavailabilities"("agent_id", "starts_at");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_service_code_fkey" FOREIGN KEY ("service_code") REFERENCES "cleaning_services"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_visits" ADD CONSTRAINT "site_visits_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "quote_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "quote_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interventions" ADD CONSTRAINT "interventions_mission_id_fkey" FOREIGN KEY ("mission_id") REFERENCES "missions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mission_payments" ADD CONSTRAINT "mission_payments_mission_id_fkey" FOREIGN KEY ("mission_id") REFERENCES "missions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_unavailabilities" ADD CONSTRAINT "agent_unavailabilities_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Ajouts manuels (non exprimables dans schema.prisma).

-- Une seule ligne de réglages, créée avec les valeurs par défaut de la partie 4 du cahier des charges.
ALTER TABLE "cleaning_settings" ADD CONSTRAINT "cleaning_settings_singleton" CHECK ("id" = 1);
INSERT INTO "cleaning_settings" ("id") VALUES (1);

-- Recherche des passages d'un agent (conflits de créneaux, missions de l'agent).
CREATE INDEX "interventions_agent_ids_idx" ON "interventions" USING GIN ("agent_ids");

-- Montants jamais négatifs (une ligne de remise vit dans le JSON des lignes du devis).
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_amounts_positive" CHECK ("subtotal" >= 0 AND "total" >= 0 AND "deposit_amount" >= 0);
ALTER TABLE "missions" ADD CONSTRAINT "missions_amounts_positive" CHECK ("payment_total" >= 0 AND "deposit_amount" >= 0);
ALTER TABLE "mission_payments" ADD CONSTRAINT "mission_payments_amount_positive" CHECK ("amount" > 0);
