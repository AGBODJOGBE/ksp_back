-- ADR-048 : une seule page de paiement en attente par objet à montant dû (mission, facture), toutes
-- parts et tous payeurs confondus, et une seule par lien de paiement. Les recharges du portefeuille
-- (wallet_top_up, nouvel argent) n'en ont pas besoin.

-- Doublons déjà présents : les plus anciens sont annulés (sans événement ; une réussite tardive
-- reste relue par le rapprochement pendant la fenêtre de réussite tardive).
UPDATE "payment_intents" AS p
   SET "status" = 'cancelled', "failure_reason" = 'cancelled', "completed_at" = CURRENT_TIMESTAMP,
       "updated_at" = CURRENT_TIMESTAMP, "version" = p."version" + 1
 WHERE p."status" = 'pending'
   AND (
     (p."subject_type" IN ('cleaning_mission', 'billing_invoice') AND EXISTS (
        SELECT 1 FROM "payment_intents" q
         WHERE q."status" = 'pending' AND q."subject_type" = p."subject_type"
           AND q."subject_id" = p."subject_id" AND q."id" > p."id"))
     OR (p."payment_link_id" IS NOT NULL AND EXISTS (
        SELECT 1 FROM "payment_intents" q
         WHERE q."status" = 'pending' AND q."payment_link_id" = p."payment_link_id" AND q."id" > p."id"))
   );

CREATE UNIQUE INDEX "payment_intents_open_subject_key" ON "payment_intents"("subject_type", "subject_id")
  WHERE "status" = 'pending' AND "subject_type" IN ('cleaning_mission', 'billing_invoice');

CREATE UNIQUE INDEX "payment_intents_open_link_key" ON "payment_intents"("payment_link_id")
  WHERE "status" = 'pending' AND "payment_link_id" IS NOT NULL;
