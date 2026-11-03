-- ADR-032 : un événement d'outbox en échec ne bloque plus les suivants. Il est réessayé avec un délai
-- croissant (next_attempt_at), puis mis de côté au-delà de la limite de tentatives (parked_at),
-- rejouable. last_error : dernier message d'erreur du broker (jamais le contenu de l'événement).

-- AlterTable
ALTER TABLE "outbox" ADD COLUMN "next_attempt_at" TIMESTAMPTZ(3),
ADD COLUMN "parked_at" TIMESTAMPTZ(3),
ADD COLUMN "last_error" TEXT;

-- Le relais ne lit que les événements non publiés et non mis de côté, dans l'ordre (index partiels,
-- non exprimables dans schema.prisma).
DROP INDEX "outbox_unpublished_idx";
CREATE INDEX "outbox_unpublished_idx" ON "outbox"("created_at", "id") WHERE "published_at" IS NULL AND "parked_at" IS NULL;
CREATE INDEX "outbox_parked_idx" ON "outbox"("parked_at") WHERE "parked_at" IS NOT NULL;
