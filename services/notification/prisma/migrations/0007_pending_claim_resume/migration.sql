-- ADR-047 : une notification restée « pending » (panne entre la réservation et l'envoi) est reprise
-- par un nouvel appel de même clé ; la date de la dernière reprise empêche deux reprises simultanées.

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN "claimed_at" TIMESTAMPTZ(3);
