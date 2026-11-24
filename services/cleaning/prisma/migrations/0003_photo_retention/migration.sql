-- Piste S, R-EX-07 et R-DP-01 (UC-NT-48) : les photos d'une visite ou d'une séance sont supprimées
-- chez file après la durée de conservation (réglage retentionMonths), puis leurs références sont
-- retirées. Les contraintes d'origine exigent une photo sur une séance réalisée, sur une séance
-- manquée et sur une visite manquée : elles refusaient le retrait de la dernière référence. La
-- garantie reste à la clôture ; elle ne vaut plus une fois les photos effacées, ce que date la
-- nouvelle colonne photos_erased_at.
ALTER TABLE "visits" ADD COLUMN "photos_erased_at" TIMESTAMPTZ(3);
ALTER TABLE "sessions" ADD COLUMN "photos_erased_at" TIMESTAMPTZ(3);

-- R-VI-05 : « manquée » est toujours une absence du client : datée, avec la photo du lieu, sauf
-- absence signalée par le back-office (R-VI-08) ou photos effacées après la durée de conservation.
ALTER TABLE "visits" DROP CONSTRAINT "visits_missed_check";
ALTER TABLE "visits" ADD CONSTRAINT "visits_missed_check" CHECK (
  ("status" = 'missed') = ("missed_at" IS NOT NULL)
  AND ("status" <> 'missed' OR "missed_photo_file_id" IS NOT NULL OR "closed_by_staff" OR "photos_erased_at" IS NOT NULL)
);
-- Partie 10 : une séance réalisée a au moins une photo « avant » et une photo « après », sauf clôture
-- par le back-office (R-EX-08) ou photos effacées après la durée de conservation.
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_completed_check";
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_completed_check" CHECK (
  "status" <> 'completed'
  OR ("completed_at" IS NOT NULL AND ("closed_by_staff" OR "photos_erased_at" IS NOT NULL OR (cardinality("before_photo_file_ids") >= 1 AND cardinality("after_photo_file_ids") >= 1)))
);
-- R-EX-02 : une séance manquée porte sa cause, son heure et la photo du lieu ; client absent : avec
-- le début de l'attente et l'appel tracé. Photo, attente et appel sont dispensés pour une absence
-- signalée par le back-office (R-EX-08) ; la photo l'est aussi une fois les photos effacées.
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_missed_check";
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_missed_check" CHECK (
  ("status" = 'missed') = ("missed_cause" IS NOT NULL)
  AND ("status" <> 'missed' OR ("missed_at" IS NOT NULL AND ("missed_photo_file_id" IS NOT NULL OR "closed_by_staff" OR "photos_erased_at" IS NOT NULL)))
  AND ("missed_cause" IS DISTINCT FROM 'customer_absent' OR "closed_by_staff" OR ("wait_started_at" IS NOT NULL AND "called_at" IS NOT NULL))
);

-- Des photos effacées le sont toutes : plus aucune référence sur la visite ni sur la séance.
ALTER TABLE "visits" ADD CONSTRAINT "visits_photos_erased_check" CHECK (
  "photos_erased_at" IS NULL
  OR (cardinality("photo_file_ids") = 0 AND "missed_photo_file_id" IS NULL)
);
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_photos_erased_check" CHECK (
  "photos_erased_at" IS NULL
  OR (cardinality("before_photo_file_ids") = 0 AND cardinality("after_photo_file_ids") = 0 AND "missed_photo_file_id" IS NULL)
);

-- Index partiels de la tâche UC-NT-48 : visites, séances et incidents qui portent encore des photos.
CREATE INDEX "visits_photos_purge_idx" ON "visits"("request_id") WHERE cardinality("photo_file_ids") > 0 OR "missed_photo_file_id" IS NOT NULL;
CREATE INDEX "sessions_photos_purge_idx" ON "sessions"("program_id") WHERE cardinality("before_photo_file_ids") > 0 OR cardinality("after_photo_file_ids") > 0 OR "missed_photo_file_id" IS NOT NULL;
CREATE INDEX "session_incidents_photos_purge_idx" ON "session_incidents"("session_id") WHERE cardinality("photo_file_ids") > 0;
