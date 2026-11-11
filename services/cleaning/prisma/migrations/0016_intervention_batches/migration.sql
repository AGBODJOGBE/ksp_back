-- ADR-052 : planification en lot des dates restantes d'un plan de passages. Trace d'idempotence par
-- (mission, clé), écrite dans la transaction des passages : un second envoi avec la même clé rend
-- le même résultat (passages créés, dates sautées) sans rien réécrire.
CREATE TABLE "intervention_batches" (
  "mission_id" UUID NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "actor_id" UUID NOT NULL,
  "outcome" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "intervention_batches_pkey" PRIMARY KEY ("mission_id", "idempotency_key"),
  CONSTRAINT "intervention_batches_mission_id_fkey" FOREIGN KEY ("mission_id") REFERENCES "missions" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
