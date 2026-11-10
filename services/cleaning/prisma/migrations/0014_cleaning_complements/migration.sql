-- ADR-053 : compléments du Nettoyage.
-- Réglages : rappel avant l'expiration d'un devis (0 = aucun rappel), photos par type et par passage,
-- durée d'une visite technique dans l'agenda de l'agent.
ALTER TABLE "cleaning_settings"
  ADD COLUMN "quote_expiry_reminder_days" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "max_intervention_photos" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN "visit_duration_minutes" INTEGER NOT NULL DEFAULT 60;

-- Rappel fait pour ce devis (un seul rappel par devis, rejeu sans double message).
ALTER TABLE "quote_requests" ADD COLUMN "expiry_reminded_quote_id" UUID;

-- Motif du dernier report d'un passage, ou de son annulation pour le replanifier.
ALTER TABLE "interventions" ADD COLUMN "change_reason" TEXT;

-- Équipe désactivée : gardée, plus proposée à la planification.
ALTER TABLE "teams" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;

-- Visites planifiées des demandes closes, cherchées par la tâche des échéances.
CREATE INDEX "site_visits_status_idx" ON "site_visits"("status");
