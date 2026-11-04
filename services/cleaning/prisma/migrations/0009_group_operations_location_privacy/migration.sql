-- Opérations de groupe, visites des agents et conservation de la position (ADR-035). Migration
-- additive : les données existantes ne changent pas.
--
-- 1. Visite technique commune à plusieurs demandes d'un groupe : identifiant partagé, null pour une
--    visite seule ; index pour la liste des visites d'un agent.
-- 2. Idempotence des opérations de groupe (auteur, opération, clé) et résultat gardé pour le rejeu.
-- 3. Réglage du back-office : mois de conservation de la position (12 par défaut) ; index pour la
--    purge des demandes et missions clôturées.

ALTER TABLE "site_visits" ADD COLUMN "group_visit_id" UUID;
CREATE INDEX "site_visits_group_visit_id_idx" ON "site_visits"("group_visit_id");
CREATE INDEX "site_visits_agent_id_scheduled_at_idx" ON "site_visits"("agent_id", "scheduled_at");

CREATE TABLE "request_group_operations" (
    "actor_id" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "group_id" UUID NOT NULL,
    "outcome" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "request_group_operations_pkey" PRIMARY KEY ("actor_id","operation","idempotency_key")
);

ALTER TABLE "cleaning_settings"
    ADD COLUMN "location_retention_months" INTEGER NOT NULL DEFAULT 12;

CREATE INDEX "quote_requests_status_updated_at_idx" ON "quote_requests"("status", "updated_at");
CREATE INDEX "missions_status_updated_at_idx" ON "missions"("status", "updated_at");
