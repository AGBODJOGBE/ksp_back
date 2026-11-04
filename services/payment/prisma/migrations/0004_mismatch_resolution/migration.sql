-- ADR-032 : un paiement amount_mismatch (argent reçu pour un autre montant ou une autre devise) bloque
-- tout nouveau paiement du même objet jusqu'à ce que la finance l'ait traité. Traitement enregistré
-- ici (date, compte du back-office, note, clé d'idempotence facultative) ; le statut reste
-- amount_mismatch. Colonnes vides pour tous les paiements existants : un écart déjà présent bloque
-- donc les nouveaux paiements de son objet jusqu'à son traitement.

-- AlterTable
ALTER TABLE "payment_intents" ADD COLUMN "mismatch_resolved_at" TIMESTAMPTZ(3),
ADD COLUMN "mismatch_resolved_by" UUID,
ADD COLUMN "mismatch_resolution_note" TEXT,
ADD COLUMN "mismatch_resolution_key" TEXT;

-- Un traitement est complet (date, auteur, note de 1 à 500 caractères) et ne concerne qu'un écart.
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_mismatch_resolution_check" CHECK (
  ("mismatch_resolved_at" IS NULL AND "mismatch_resolved_by" IS NULL AND "mismatch_resolution_note" IS NULL
    AND "mismatch_resolution_key" IS NULL)
  OR ("status" = 'amount_mismatch' AND "mismatch_resolved_at" IS NOT NULL AND "mismatch_resolved_by" IS NOT NULL
    AND char_length("mismatch_resolution_note") BETWEEN 1 AND 500)
);
