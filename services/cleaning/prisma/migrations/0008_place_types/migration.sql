-- Parcours client par type de lieu et position GPS (ADR-034). Migration additive.
--
-- 1. Types de lieu gérés au back-office (Maison, Villa, Appartement, Bureau, Chantier…) avec la
--    liste ordonnée des prestations qu'ils proposent.
-- 2. Groupes de demandes : plusieurs prestations pour un même lieu, une demande par prestation,
--    idempotents par (client, clé).
-- 3. Demandes : groupe, type de lieu, position GPS, repère, fournisseur et adresse du géocodage ;
--    missions : position, repère, groupe et type de lieu copiés de la demande ; zones : noms
--    alternatifs. Tout est nullable : les demandes et missions existantes ne changent pas.
--    Coordonnées en DOUBLE PRECISION (degrés WGS 84) : la précision du GPS d'un téléphone est
--    largement couverte, et la valeur se lit directement en nombre (Prisma Float), sans
--    conversion décimale.
-- 4. Données de départ (prix vides, comme l'ADR-033) : prestations « Nettoyage de maison » et
--    « Nettoyage de vitres », cinq types de lieu. Rejouable, sans rien écraser de ce que l'admin a
--    changé (ON CONFLICT DO NOTHING ; une prestation existante ne reçoit pas de nouvelle version).

CREATE TABLE "place_types" (
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "icon" TEXT NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "service_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,
    "updated_at" TIMESTAMPTZ(3),

    CONSTRAINT "place_types_pkey" PRIMARY KEY ("code")
);

CREATE TABLE "quote_request_groups" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "place_type" TEXT NOT NULL,
    "commune" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quote_request_groups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "quote_request_groups_customer_id_idempotency_key_key"
    ON "quote_request_groups"("customer_id", "idempotency_key");

ALTER TABLE "quote_requests"
  ADD COLUMN "group_id" UUID,
  ADD COLUMN "place_type" TEXT,
  ADD COLUMN "latitude" DOUBLE PRECISION,
  ADD COLUMN "longitude" DOUBLE PRECISION,
  ADD COLUMN "location_accuracy_m" DOUBLE PRECISION,
  ADD COLUMN "landmark" TEXT,
  ADD COLUMN "geocoding_provider" TEXT,
  ADD COLUMN "geocoded_address" TEXT,
  ADD CONSTRAINT "quote_requests_latitude_check" CHECK ("latitude" IS NULL OR "latitude" BETWEEN -90 AND 90),
  ADD CONSTRAINT "quote_requests_longitude_check" CHECK ("longitude" IS NULL OR "longitude" BETWEEN -180 AND 180),
  ADD CONSTRAINT "quote_requests_group_id_fkey" FOREIGN KEY ("group_id")
    REFERENCES "quote_request_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "quote_requests_group_id_idx" ON "quote_requests"("group_id");

ALTER TABLE "missions"
  ADD COLUMN "latitude" DOUBLE PRECISION,
  ADD COLUMN "longitude" DOUBLE PRECISION,
  ADD COLUMN "location_accuracy_m" DOUBLE PRECISION,
  ADD COLUMN "landmark" TEXT,
  ADD COLUMN "group_id" UUID,
  ADD COLUMN "place_type" TEXT;

CREATE INDEX "missions_group_id_idx" ON "missions"("group_id");

ALTER TABLE "service_zones" ADD COLUMN "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Prestations de départ, prix à null (modifiables au back-office).
CREATE TEMPORARY TABLE "seed_services" (
  "code" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "unit" TEXT NOT NULL,
  "fields" JSONB NOT NULL,
  "option_definitions" JSONB NOT NULL,
  "frequencies" JSONB NOT NULL,
  "team_size" JSONB NOT NULL
);

INSERT INTO "seed_services" VALUES
  ('house_cleaning', 'Nettoyage de maison', 'Ménage complet de la maison : pièces, sanitaires, cours.', 'room', '[{"helpText":null,"unitLabel":"m²","min":1,"max":100000,"pricePerUnit":null,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"surface","label":"Superficie","type":"number","required":true,"active":true},{"helpText":null,"unitLabel":"chambres","min":1,"max":50,"pricePerUnit":null,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"bedrooms","label":"Nombre de chambres","type":"number","required":true,"active":true},{"helpText":null,"unitLabel":"salles de bain","min":0,"max":20,"pricePerUnit":null,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"bathrooms","label":"Nombre de salles de bain","type":"number","required":true,"active":true},{"helpText":null,"unitLabel":null,"min":null,"max":null,"pricePerUnit":null,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"front_yard","label":"Cour avant","type":"boolean","required":true,"active":true},{"helpText":null,"unitLabel":null,"min":null,"max":null,"pricePerUnit":null,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"back_yard","label":"Arrière-cour","type":"boolean","required":true,"active":true},{"helpText":null,"unitLabel":null,"min":null,"max":null,"pricePerUnit":null,"choices":[{"code":"normal","label":"Normal","supplement":null,"coefficientBp":null,"active":true},{"code":"dirty","label":"Sale","supplement":null,"coefficientBp":null,"active":true},{"code":"very_dirty","label":"Très sale","supplement":null,"coefficientBp":null,"active":true}],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"condition","label":"État de la maison","type":"choice","required":true,"active":true},{"helpText":null,"unitLabel":null,"min":null,"max":null,"pricePerUnit":null,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"pets","label":"Présence d''animaux","type":"boolean","required":false,"active":true}]'::jsonb, '[{"code":"windows","label":"Vitres","description":null,"active":true,"flatPrice":null,"fields":[{"helpText":null,"unitLabel":"fenêtres","min":1,"max":200,"pricePerUnit":null,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"window_count","label":"Nombre de fenêtres","type":"number","required":true,"active":true}]}]'::jsonb, '[{"code":"once","label":"Une fois","coefficientBp":10000,"active":true},{"code":"weekly","label":"Chaque semaine","coefficientBp":10000,"active":true},{"code":"monthly","label":"Chaque mois","coefficientBp":10000,"active":true}]'::jsonb, '{"fieldCode":"bedrooms","unitsPerAgent":3,"minAgents":1,"maxAgents":6}'::jsonb),
  ('window_cleaning', 'Nettoyage de vitres', 'Fenêtres et baies vitrées, intérieur et extérieur.', 'square_meter', '[{"helpText":null,"unitLabel":"fenêtres","min":1,"max":1000,"pricePerUnit":null,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"window_count","label":"Nombre de fenêtres","type":"number","required":true,"active":true},{"helpText":null,"unitLabel":null,"min":null,"max":null,"pricePerUnit":null,"choices":[{"code":"ground_floor","label":"Plain-pied","supplement":null,"coefficientBp":null,"active":true},{"code":"at_height","label":"En hauteur","supplement":null,"coefficientBp":null,"active":true}],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"access","label":"Accès aux fenêtres","type":"choice","required":true,"active":true}]'::jsonb, '[]'::jsonb, '[{"code":"once","label":"Une fois","coefficientBp":10000,"active":true},{"code":"weekly","label":"Chaque semaine","coefficientBp":10000,"active":true},{"code":"monthly","label":"Chaque mois","coefficientBp":10000,"active":true}]'::jsonb, '{"fieldCode":"window_count","unitsPerAgent":20,"minAgents":1,"maxAgents":4}'::jsonb);

-- Une prestation déjà créée (par l'admin ou une exécution précédente) n'est pas touchée : seule
-- une prestation créée ici reçoit sa première version de grille.
WITH "created" AS (
  INSERT INTO "cleaning_services" ("code", "name", "description", "unit", "active")
  SELECT "code", "name", "description", "unit", true FROM "seed_services"
  ON CONFLICT ("code") DO NOTHING
  RETURNING "code"
)
INSERT INTO "pricing_rules"
  ("id", "service_code", "version", "unit_price", "minimum_price", "options", "commune_coefficients",
   "default_coefficient_bp", "team_size", "checklist", "created_by", "created_at",
   "fields", "option_definitions", "frequencies")
SELECT
  gen_random_uuid(),
  s."code",
  1,
  NULL,
  NULL,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('code', o->>'code', 'label', o->>'label', 'price', NULL)), '[]'::jsonb)
     FROM jsonb_array_elements(s."option_definitions") AS o),
  '{}'::jsonb,
  10000,
  s."team_size",
  '[]'::jsonb,
  'migration',
  now(),
  s."fields",
  s."option_definitions",
  s."frequencies"
FROM "seed_services" AS s
JOIN "created" AS c ON c."code" = s."code";

DROP TABLE "seed_services";

-- Types de lieu de départ ; un type de lieu déjà présent garde ce que l'admin a choisi.
INSERT INTO "place_types" ("code", "label", "description", "icon", "display_order", "active", "service_codes", "updated_by", "updated_at") VALUES
  ('house', 'Maison', 'Maison individuelle, avec ou sans cour.', 'house', 10, true,
   ARRAY['house_cleaning', 'garden_maintenance', 'window_cleaning', 'septic_emptying', 'pest_control'], 'migration', now()),
  ('villa', 'Villa', 'Villa avec jardin, cour ou dépendances.', 'villa', 20, true,
   ARRAY['house_cleaning', 'garden_maintenance', 'window_cleaning', 'septic_emptying', 'pest_control'], 'migration', now()),
  ('apartment', 'Appartement', 'Appartement en immeuble.', 'apartment', 30, true,
   ARRAY['home_cleaning', 'window_cleaning', 'pest_control'], 'migration', now()),
  ('office', 'Bureau', 'Bureaux et locaux professionnels.', 'office', 40, true,
   ARRAY['office_cleaning', 'window_cleaning', 'pest_control', 'septic_emptying'], 'migration', now()),
  ('construction_site', 'Chantier', 'Chantier terminé ou en finition.', 'construction', 50, true,
   ARRAY['post_construction', 'window_cleaning'], 'migration', now())
ON CONFLICT ("code") DO NOTHING;
