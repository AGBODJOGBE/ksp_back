-- Socle commun à chaque service : outbox (événements à publier) et inbox (événements déjà traités).

-- CreateTable
CREATE TABLE "outbox" (
    "id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "event_id" UUID NOT NULL,
    "consumer" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("event_id","consumer")
);

-- Le relais ne lit que les événements non publiés, dans l'ordre : index partiel (non exprimable dans schema.prisma).
CREATE INDEX "outbox_unpublished_idx" ON "outbox"("created_at", "id") WHERE "published_at" IS NULL;
