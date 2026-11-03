-- ADR-032 : un événement d'outbox en échec ne bloque plus les suivants. Il est réessayé avec un délai
-- croissant (next_attempt_at), puis mis de côté après 24 h d'échecs depuis le premier
-- (first_failed_at, parked_at), rejouable (pnpm outbox:replay). last_error : dernier message
-- d'erreur du broker (jamais le contenu de l'événement).

-- AlterTable
ALTER TABLE "outbox" ADD COLUMN "next_attempt_at" TIMESTAMPTZ(3),
ADD COLUMN "parked_at" TIMESTAMPTZ(3),
ADD COLUMN "last_error" TEXT,
ADD COLUMN "first_failed_at" TIMESTAMPTZ(3);

-- Les événements en attente repartent de zéro : un compteur hérité de l'ancien relais (qui comptait
-- chaque passage bloqué) ne doit pas compter dans les nouvelles règles.
UPDATE "outbox" SET "attempts" = 0, "next_attempt_at" = NULL, "parked_at" = NULL, "last_error" = NULL,
  "first_failed_at" = NULL
WHERE "published_at" IS NULL;

-- Le relais ne lit que les événements non publiés et non mis de côté, dans l'ordre (index partiels,
-- non exprimables dans schema.prisma).
DROP INDEX "outbox_unpublished_idx";
CREATE INDEX "outbox_unpublished_idx" ON "outbox"("created_at", "id") WHERE "published_at" IS NULL AND "parked_at" IS NULL;
CREATE INDEX "outbox_parked_idx" ON "outbox"("parked_at") WHERE "parked_at" IS NOT NULL;
