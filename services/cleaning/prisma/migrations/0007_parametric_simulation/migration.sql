-- Simulation de prix paramétrable au back-office (ADR-033).
--
-- 1. La version de grille porte désormais la définition complète d'une prestation : champs du
--    formulaire, options (avec leurs champs) et fréquences propres (JSON). Les anciennes colonnes
--    unit_price et options restent remplies (valeurs déduites), pour les anciens lecteurs.
-- 2. Une demande de devis garde ses réponses, ses options choisies, sa fréquence, la version de
--    grille et le détail du calcul (null pour les demandes antérieures).
-- 3. Données de départ : les six prestations, prix à null (modifiables au back-office). Une
--    prestation absente est créée active ; une prestation existante (données de démonstration)
--    garde son nom, sa description et son état, et reçoit une nouvelle version au nouveau
--    modèle (minimum, coefficients de commune et liste de contrôle repris de la version en
--    vigueur ; prix des champs et des options à null). Rejouable : une prestation déjà au nouveau
--    modèle n'est pas modifiée.

ALTER TABLE "pricing_rules"
  ADD COLUMN "fields" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "option_definitions" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "frequencies" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "quote_requests"
  ADD COLUMN "answers" JSONB,
  ADD COLUMN "option_selections" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "frequency" TEXT,
  ADD COLUMN "pricing_version" INTEGER,
  ADD COLUMN "calculation" JSONB;

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
  ('garden_maintenance', 'Entretien de jardin', 'Tonte, désherbage et entretien des espaces verts.', 'square_meter', '[{"helpText":null,"unitLabel":"m²","min":1,"max":100000,"pricePerUnit":null,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"surface","label":"Superficie","type":"number","required":true,"active":true},{"helpText":null,"unitLabel":null,"min":null,"max":null,"pricePerUnit":null,"choices":[{"code":"maintained","label":"Entretenu","supplement":null,"coefficientBp":null,"active":true},{"code":"overgrown","label":"Envahi","supplement":null,"coefficientBp":null,"active":true},{"code":"very_overgrown","label":"Très envahi","supplement":null,"coefficientBp":null,"active":true}],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"condition","label":"État de la pelouse ou du jardin","type":"choice","required":true,"active":true}]'::jsonb, '[{"code":"hedge_trimming","label":"Taille de haies","description":null,"active":true,"flatPrice":null,"fields":[{"helpText":null,"unitLabel":"mètres linéaires","min":1,"max":5000,"pricePerUnit":null,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"hedge_length","label":"Longueur de haies","type":"number","required":true,"active":true}]},{"code":"green_waste_removal","label":"Évacuation des déchets verts","description":null,"active":true,"flatPrice":null,"fields":[]}]'::jsonb, '[{"code":"once","label":"Une fois","coefficientBp":10000,"active":true},{"code":"weekly","label":"Chaque semaine","coefficientBp":10000,"active":true},{"code":"monthly","label":"Chaque mois","coefficientBp":10000,"active":true}]'::jsonb, '{"fieldCode":"surface","unitsPerAgent":300,"minAgents":1,"maxAgents":6}'::jsonb),
  ('septic_emptying', 'Vidange', 'Vidange de fosse septique ou de puisard.', 'cubic_meter', '[{"helpText":null,"unitLabel":"m³","min":1,"max":200,"pricePerUnit":null,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"tank_volume","label":"Volume de la fosse","type":"number","required":true,"active":true},{"helpText":null,"unitLabel":null,"min":null,"max":null,"pricePerUnit":null,"choices":[{"code":"septic_tank","label":"Fosse septique","supplement":null,"coefficientBp":null,"active":true},{"code":"cesspool","label":"Puisard","supplement":null,"coefficientBp":null,"active":true}],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"tank_type","label":"Type de fosse","type":"choice","required":true,"active":true},{"helpText":null,"unitLabel":null,"min":null,"max":null,"pricePerUnit":null,"choices":[{"code":"easy","label":"Facile","supplement":null,"coefficientBp":null,"active":true},{"code":"difficult","label":"Difficile","supplement":null,"coefficientBp":null,"active":true}],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"truck_access","label":"Accès du camion","type":"choice","required":true,"active":true}]'::jsonb, '[{"code":"desludging","label":"Curage","description":null,"active":true,"flatPrice":null,"fields":[]}]'::jsonb, '[{"code":"once","label":"Une fois","coefficientBp":10000,"active":true}]'::jsonb, '{"fieldCode":"tank_volume","unitsPerAgent":10,"minAgents":2,"maxAgents":3}'::jsonb),
  ('home_cleaning', 'Nettoyage à domicile', 'Ménage complet du logement.', 'room', '[{"helpText":null,"unitLabel":null,"min":null,"max":null,"pricePerUnit":null,"choices":[{"code":"studio","label":"Studio","supplement":null,"coefficientBp":null,"active":true},{"code":"apartment","label":"Appartement","supplement":null,"coefficientBp":null,"active":true},{"code":"villa","label":"Villa","supplement":null,"coefficientBp":null,"active":true}],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"housing_type","label":"Type de logement","type":"choice","required":true,"active":true},{"helpText":null,"unitLabel":"pièces","min":1,"max":50,"pricePerUnit":null,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"rooms","label":"Nombre de pièces","type":"number","required":true,"active":true},{"helpText":null,"unitLabel":"salles de bain","min":0,"max":20,"pricePerUnit":null,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"bathrooms","label":"Nombre de salles de bain","type":"number","required":true,"active":true},{"helpText":null,"unitLabel":null,"min":null,"max":null,"pricePerUnit":null,"choices":[{"code":"normal","label":"Normal","supplement":null,"coefficientBp":null,"active":true},{"code":"dirty","label":"Sale","supplement":null,"coefficientBp":null,"active":true},{"code":"very_dirty","label":"Très sale","supplement":null,"coefficientBp":null,"active":true}],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"condition","label":"État du logement","type":"choice","required":true,"active":true},{"helpText":null,"unitLabel":null,"min":null,"max":null,"pricePerUnit":null,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"pets","label":"Présence d''animaux","type":"boolean","required":false,"active":true}]'::jsonb, '[{"code":"windows","label":"Vitres","description":null,"active":true,"flatPrice":null,"fields":[{"helpText":null,"unitLabel":"fenêtres","min":1,"max":200,"pricePerUnit":null,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"window_count","label":"Nombre de fenêtres","type":"number","required":true,"active":true}]},{"code":"sofa","label":"Canapé","description":null,"active":true,"flatPrice":null,"fields":[{"helpText":null,"unitLabel":"places","min":1,"max":20,"pricePerUnit":null,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"seats","label":"Nombre de places","type":"number","required":true,"active":true}]},{"code":"appliances","label":"Électroménager","description":null,"active":true,"flatPrice":null,"fields":[]}]'::jsonb, '[{"code":"once","label":"Une fois","coefficientBp":10000,"active":true},{"code":"weekly","label":"Chaque semaine","coefficientBp":10000,"active":true},{"code":"monthly","label":"Chaque mois","coefficientBp":10000,"active":true}]'::jsonb, '{"fieldCode":"rooms","unitsPerAgent":3,"minAgents":1,"maxAgents":6}'::jsonb),
  ('office_cleaning', 'Nettoyage de bureaux', 'Bureaux, sanitaires et parties communes.', 'square_meter', '[{"helpText":null,"unitLabel":"m²","min":1,"max":100000,"pricePerUnit":null,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"surface","label":"Superficie","type":"number","required":true,"active":true},{"helpText":null,"unitLabel":"sanitaires","min":0,"max":200,"pricePerUnit":null,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"restrooms","label":"Nombre de sanitaires","type":"number","required":true,"active":true},{"helpText":null,"unitLabel":null,"min":null,"max":null,"pricePerUnit":null,"choices":[{"code":"normal","label":"Normal","supplement":null,"coefficientBp":null,"active":true},{"code":"dirty","label":"Sale","supplement":null,"coefficientBp":null,"active":true},{"code":"very_dirty","label":"Très sale","supplement":null,"coefficientBp":null,"active":true}],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"condition","label":"État des locaux","type":"choice","required":true,"active":true}]'::jsonb, '[{"code":"windows","label":"Vitres","description":null,"active":true,"flatPrice":null,"fields":[{"helpText":null,"unitLabel":"fenêtres","min":1,"max":1000,"pricePerUnit":null,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"window_count","label":"Nombre de fenêtres","type":"number","required":true,"active":true}]},{"code":"carpet","label":"Moquette","description":null,"active":true,"flatPrice":null,"fields":[{"helpText":null,"unitLabel":"m²","min":1,"max":100000,"pricePerUnit":null,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"carpet_surface","label":"Surface de moquette","type":"number","required":true,"active":true}]}]'::jsonb, '[{"code":"once","label":"Une fois","coefficientBp":10000,"active":true},{"code":"weekly","label":"Chaque semaine","coefficientBp":10000,"active":true},{"code":"monthly","label":"Chaque mois","coefficientBp":10000,"active":true}]'::jsonb, '{"fieldCode":"surface","unitsPerAgent":150,"minAgents":1,"maxAgents":8}'::jsonb),
  ('post_construction', 'Nettoyage de fin de chantier', 'Gravats fins, poussières, vitres.', 'square_meter', '[{"helpText":null,"unitLabel":"m²","min":1,"max":100000,"pricePerUnit":null,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"surface","label":"Superficie","type":"number","required":true,"active":true},{"helpText":null,"unitLabel":"niveaux","min":1,"max":50,"pricePerUnit":null,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"floors","label":"Nombre de niveaux","type":"number","required":true,"active":true},{"helpText":null,"unitLabel":null,"min":null,"max":null,"pricePerUnit":null,"choices":[{"code":"light","label":"Léger","supplement":null,"coefficientBp":null,"active":true},{"code":"medium","label":"Moyen","supplement":null,"coefficientBp":null,"active":true},{"code":"heavy","label":"Lourd","supplement":null,"coefficientBp":null,"active":true}],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"condition","label":"État du chantier","type":"choice","required":true,"active":true}]'::jsonb, '[{"code":"rubble_removal","label":"Évacuation des gravats","description":null,"active":true,"flatPrice":null,"fields":[{"helpText":null,"unitLabel":"m³","min":1,"max":500,"pricePerUnit":null,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"rubble_volume","label":"Volume de gravats","type":"number","required":true,"active":true}]},{"code":"windows","label":"Vitres","description":null,"active":true,"flatPrice":null,"fields":[{"helpText":null,"unitLabel":"fenêtres","min":1,"max":1000,"pricePerUnit":null,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"window_count","label":"Nombre de fenêtres","type":"number","required":true,"active":true}]}]'::jsonb, '[{"code":"once","label":"Une fois","coefficientBp":10000,"active":true},{"code":"weekly","label":"Chaque semaine","coefficientBp":10000,"active":true},{"code":"monthly","label":"Chaque mois","coefficientBp":10000,"active":true}]'::jsonb, '{"fieldCode":"surface","unitsPerAgent":100,"minAgents":2,"maxAgents":10}'::jsonb),
  ('pest_control', 'Désinsectisation', 'Traitement contre les insectes.', 'square_meter', '[{"helpText":null,"unitLabel":"m²","min":1,"max":100000,"pricePerUnit":null,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"surface","label":"Superficie","type":"number","required":true,"active":true},{"helpText":null,"unitLabel":null,"min":null,"max":null,"pricePerUnit":null,"choices":[{"code":"cockroaches","label":"Cafards","supplement":null,"coefficientBp":null,"active":true},{"code":"mosquitoes","label":"Moustiques","supplement":null,"coefficientBp":null,"active":true},{"code":"bed_bugs","label":"Punaises de lit","supplement":null,"coefficientBp":null,"active":true},{"code":"termites","label":"Termites","supplement":null,"coefficientBp":null,"active":true}],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"pest","label":"Nuisible visé","type":"choice","required":true,"active":true},{"helpText":null,"unitLabel":null,"min":null,"max":null,"pricePerUnit":null,"choices":[{"code":"housing","label":"Logement","supplement":null,"coefficientBp":null,"active":true},{"code":"office","label":"Bureau","supplement":null,"coefficientBp":null,"active":true},{"code":"shop","label":"Commerce","supplement":null,"coefficientBp":null,"active":true},{"code":"warehouse","label":"Entrepôt","supplement":null,"coefficientBp":null,"active":true}],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"premises_type","label":"Type de local","type":"choice","required":true,"active":true},{"helpText":null,"unitLabel":null,"min":null,"max":null,"pricePerUnit":null,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"pets","label":"Présence d''animaux","type":"boolean","required":false,"active":true}]'::jsonb, '[{"code":"follow_up_treatment","label":"Traitement de suivi","description":null,"active":true,"flatPrice":null,"fields":[]}]'::jsonb, '[{"code":"once","label":"Une fois","coefficientBp":10000,"active":true}]'::jsonb, '{"fieldCode":"surface","unitsPerAgent":200,"minAgents":1,"maxAgents":4}'::jsonb);

-- Unité de l'ancien formulaire déduite du champ de la taille d'équipe (vidange : m³).
INSERT INTO "cleaning_services" ("code", "name", "description", "unit", "active")
SELECT "code", "name", "description", "unit", true FROM "seed_services"
ON CONFLICT ("code") DO UPDATE SET "unit" = EXCLUDED."unit"
WHERE NOT EXISTS (
  SELECT 1 FROM "pricing_rules" AS p
  WHERE p."service_code" = "cleaning_services"."code" AND p."fields" <> '[]'::jsonb
);

INSERT INTO "pricing_rules"
  ("id", "service_code", "version", "unit_price", "minimum_price", "options", "commune_coefficients",
   "default_coefficient_bp", "team_size", "checklist", "created_by", "created_at",
   "fields", "option_definitions", "frequencies")
SELECT
  gen_random_uuid(),
  s."code",
  COALESCE(latest."version", 0) + 1,
  NULL,
  latest."minimum_price",
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('code', o->>'code', 'label', o->>'label', 'price', NULL)), '[]'::jsonb)
     FROM jsonb_array_elements(s."option_definitions") AS o),
  COALESCE(latest."commune_coefficients", '{}'::jsonb),
  COALESCE(latest."default_coefficient_bp", 10000),
  s."team_size",
  COALESCE(latest."checklist", '[]'::jsonb),
  'migration',
  now(),
  s."fields",
  s."option_definitions",
  s."frequencies"
FROM "seed_services" AS s
LEFT JOIN LATERAL (
  SELECT * FROM "pricing_rules" AS p WHERE p."service_code" = s."code" ORDER BY p."version" DESC LIMIT 1
) AS latest ON true
WHERE latest."id" IS NULL OR latest."fields" = '[]'::jsonb;

DROP TABLE "seed_services";
