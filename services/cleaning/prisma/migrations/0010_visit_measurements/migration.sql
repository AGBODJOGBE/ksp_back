-- Mesures constatées sur le terrain après la visite technique (ADR-037). Migration additive : les
-- données existantes ne changent pas (colonnes nulles = aucune mesure).
--
-- Les réponses du client (answers, option_selections, frequency, calculation) ne sont jamais
-- remplacées : les mesures, leur calcul (grille en vigueur et commune de la demande au moment de la
-- saisie), leur version de grille, leur date et leur auteur sont gardés à part. Le devis est
-- prérempli depuis le calcul des mesures quand il existe.

ALTER TABLE "quote_requests"
    ADD COLUMN "measured_answers" JSONB,
    ADD COLUMN "measured_option_selections" JSONB,
    ADD COLUMN "measured_frequency" TEXT,
    ADD COLUMN "measured_calculation" JSONB,
    ADD COLUMN "measured_pricing_version" INTEGER,
    ADD COLUMN "measured_at" TIMESTAMPTZ(3),
    ADD COLUMN "measured_by" UUID;
