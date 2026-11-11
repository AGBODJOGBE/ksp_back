-- ADR-052 : plan de passages par dates. Le plan (mode, période, jours, heure de début, jours exclus et
-- ajoutés) et la liste exacte des dates qu'il donne, sur la demande, le devis (figés à l'envoi) et la
-- mission (copiés à l'acceptation). La colonne "recurrence" reste : ancien format, ou récurrence
-- déduite du plan pour les anciens lecteurs.
ALTER TABLE "quote_requests"
  ADD COLUMN "schedule" JSONB,
  ADD COLUMN "scheduled_dates" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "quotes"
  ADD COLUMN "schedule" JSONB,
  ADD COLUMN "scheduled_dates" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "missions"
  ADD COLUMN "schedule" JSONB,
  ADD COLUMN "scheduled_dates" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Conversion de l'ancien format quand elle est exacte : une prestation ponctuelle (sans récurrence,
-- un seul passage) dont le jour est connu sans ambiguïté devient un plan d'une date, à l'heure du
-- créneau, dans le fuseau du Bénin (Africa/Porto-Novo, UTC+1 sans heure d'été) :
-- - mission : son créneau choisi ;
-- - devis : son unique créneau proposé.
-- Les récurrences ne sont pas converties (jours de semaine inconnus, nombre de passages figé dans le
-- prix) : elles restent lisibles telles quelles, en lecture seule. Les demandes ne le sont pas non
-- plus : leur plan remplacerait les créneaux que la supervision propose au devis.
CREATE FUNCTION pg_temp.single_date_schedule(start_at TIMESTAMPTZ) RETURNS JSONB AS $$
  SELECT jsonb_build_object(
    'mode', 'dates',
    'dates', jsonb_build_array(to_char(start_at AT TIME ZONE 'Africa/Porto-Novo', 'YYYY-MM-DD')),
    'startDate', NULL,
    'endDate', NULL,
    'weekdays', '[]'::jsonb,
    'everyWeeks', 1,
    'monthDays', '[]'::jsonb,
    'weeksOfMonth', '[]'::jsonb,
    'startTime', to_char(start_at AT TIME ZONE 'Africa/Porto-Novo', 'HH24:MI'),
    'excludedDates', '[]'::jsonb,
    'extraDates', '[]'::jsonb
  )
$$ LANGUAGE SQL IMMUTABLE;

UPDATE "missions"
SET "schedule" = pg_temp.single_date_schedule("chosen_slot_start"),
    "scheduled_dates" = ARRAY[to_char("chosen_slot_start" AT TIME ZONE 'Africa/Porto-Novo', 'YYYY-MM-DD')]
WHERE "recurrence" IS NULL AND "planned_interventions" = 1;

UPDATE "quotes"
SET "schedule" = pg_temp.single_date_schedule(("proposed_slots" -> 0 ->> 'start')::TIMESTAMPTZ),
    "scheduled_dates" = ARRAY[
      to_char(("proposed_slots" -> 0 ->> 'start')::TIMESTAMPTZ AT TIME ZONE 'Africa/Porto-Novo', 'YYYY-MM-DD')
    ]
WHERE "recurrence" IS NULL AND "intervention_count" = 1 AND jsonb_array_length("proposed_slots") = 1;
