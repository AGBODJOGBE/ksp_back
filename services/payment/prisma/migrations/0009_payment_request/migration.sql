-- v2 (R-WL-05, ADR-055 décision 2) : paiement direct d'un objet (TopUpPaymentService.CreatePaymentRequest).
-- Indispensable : le paiement est une recharge « wallet_top_up » qui doit garder l'objet visé (target)
-- pour le publier dans payment.intent.succeeded à sa réussite, parfois bien après la demande
-- (notification ou rapprochement) et le rendre dans Payment.target ; le libellé du service demandeur
-- doit aussi rester pour redemander la page au prestataire (panne au premier essai). Colonnes vides
-- pour tout autre paiement.
ALTER TABLE "payment_intents"
  ADD COLUMN "target_service" TEXT,
  ADD COLUMN "target_object_type" TEXT,
  ADD COLUMN "target_object_id" UUID,
  ADD COLUMN "target_part" TEXT,
  ADD COLUMN "target_reference" TEXT,
  ADD COLUMN "description" TEXT;

-- Objet visé entier ou absent, porté seulement par une recharge d'un compte connecté. Chaque colonne
-- obligatoire est testée par IS NOT NULL : une comparaison avec NULL ne ferait pas échouer la contrainte.
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_target_check" CHECK (
  ("target_service" IS NULL AND "target_object_type" IS NULL AND "target_object_id" IS NULL
    AND "target_part" IS NULL AND "target_reference" IS NULL AND "description" IS NULL)
  OR ("target_service" IS NOT NULL AND "target_service" ~ '^[a-z][a-z0-9-]*$'
    AND "target_object_type" IS NOT NULL AND "target_object_type" ~ '^[a-z0-9_]{3,50}$'
    AND "target_object_id" IS NOT NULL
    AND ("target_part" IS NULL OR "target_part" ~ '^[a-z][a-z0-9_]{0,29}$')
    AND "target_reference" IS NOT NULL AND char_length("target_reference") BETWEEN 1 AND 60
    AND "description" IS NOT NULL AND char_length("description") BETWEEN 1 AND 140
    AND "subject_type" = 'wallet_top_up'
    AND "customer_id" IS NOT NULL)
);

-- Idempotence par (service demandeur, clé), quel que soit le payeur ; la clé enregistrée est préfixée
-- du service (« cleaning:<clé> »), jamais confondue avec celle d'une recharge ordinaire.
CREATE UNIQUE INDEX "payment_intents_direct_key" ON "payment_intents"("target_service", "idempotency_key")
  WHERE "target_service" IS NOT NULL;

-- Page encore ouverte pour un objet visé (réutilisée pour le même montant, remplacée sinon). Pas
-- d'unicité : une page que le prestataire ne sait pas annuler reste payable jusqu'à sa validité, et un
-- montant reçu en trop reste au portefeuille (ADR-055).
CREATE INDEX "payment_intents_open_target_idx"
  ON "payment_intents"("target_service", "target_object_type", "target_object_id")
  WHERE "status" = 'pending' AND "target_service" IS NOT NULL;
