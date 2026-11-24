-- ============================================================================================
-- DONNÉES DE DÉMONSTRATION — DÉVELOPPEMENT UNIQUEMENT. NE JAMAIS CHARGER EN PRÉPRODUCTION
-- NI EN PRODUCTION.
--
-- Jeu v2 minimal (ADR-054) : réglages, trois zones desservies, une catégorie de lieu, un lieu, une
-- compétence, un type de nettoyage, quatre paramètres, une offre et son tarif publié par tranches.
-- Prix INVENTÉS (exemple « Maison × Sol » du cahier des charges, partie 4) : ils ne viennent pas
-- de l'équipe Nettoyage. En production, le catalogue est saisi au back-office.
--
-- Chargement, après la migration 0001_init_v2, avec l'accord explicite ksp.demo=on :
--   PGOPTIONS='-c ksp.demo=on' psql postgresql://cleaning:cleaning@localhost:5432/cleaning \
--     -f services/cleaning/prisma/demo/demo-data.sql
-- Rejouable : identifiants fixes, une ligne déjà présente n'est pas modifiée. Prévu pour une base
-- remise à zéro (ADR-054, décision 3) ; une seule transaction : en cas d'échec, rien n'est
-- enregistré.
-- ============================================================================================

BEGIN;

DO $$
BEGIN
  IF coalesce(current_setting('ksp.demo', true), '') <> 'on' THEN
    RAISE EXCEPTION 'Données de démonstration refusées : développement uniquement (lancer avec ksp.demo=on).';
  END IF;
END $$;

-- Réglages : frais de visite par défaut (R-FV-01) ; les autres réglages gardent leur valeur.
UPDATE "cleaning_settings"
SET "default_visit_fee" = 5000, "updated_at" = now(), "version" = "version" + 1
WHERE "id" = 1 AND "default_visit_fee" <> 5000;

-- Zones desservies au départ (partie 4) : clés de commune du référentiel de geo ; majoration fixe
-- des frais de visite à Abomey-Calavi (R-FV-01). Mode de planification : celui des réglages.
INSERT INTO "zones" ("id", "commune_key", "name", "coefficient_bp", "visit_fee_surcharge", "active", "created_at", "updated_at")
VALUES
  ('0192f1c4-de70-7000-8000-000000000a01', 'cotonou', 'Cotonou', 10000, NULL, true, now(), now()),
  ('0192f1c4-de70-7000-8000-000000000a02', 'porto-novo', 'Porto-Novo', 10000, NULL, true, now(), now()),
  ('0192f1c4-de70-7000-8000-000000000a03', 'abomey-calavi', 'Abomey-Calavi', 10500, 1000, true, now(), now())
ON CONFLICT DO NOTHING;

-- Catalogue : catégorie « Maison », lieu « Villa », compétence et type « Sol ».
INSERT INTO "place_categories" ("id", "code", "name", "description", "icon", "display_order", "visit_fee", "active", "created_at", "updated_at")
VALUES ('0192f1c4-de70-7000-8000-000000000b01', 'house', 'Maison', '[DÉMO] Logements individuels.', 'house', 0, NULL, true, now(), now())
ON CONFLICT DO NOTHING;

INSERT INTO "skills" ("id", "code", "name", "active", "created_at", "updated_at")
VALUES ('0192f1c4-de70-7000-8000-000000000c01', 'indoor_cleaning', 'Nettoyage intérieur', true, now(), now())
ON CONFLICT DO NOTHING;

INSERT INTO "parameters" ("id", "code", "label", "kind", "unit", "min_value", "max_value", "choices", "required", "help", "active", "created_at", "updated_at")
VALUES
  ('0192f1c4-de70-7000-8000-000000000d01', 'surface', 'Superficie', 'number', 'm²', 1, 5000, '[]'::jsonb, true, 'Surface au sol à nettoyer.', true, now(), now()),
  ('0192f1c4-de70-7000-8000-000000000d02', 'bedrooms', 'Nombre de chambres', 'number', 'chambres', 0, 20, '[]'::jsonb, true, '', true, now(), now()),
  ('0192f1c4-de70-7000-8000-000000000d03', 'yard', 'Cour', 'boolean', NULL, NULL, NULL, '[]'::jsonb, false, '', true, now(), now()),
  ('0192f1c4-de70-7000-8000-000000000d04', 'dirt_level', 'Niveau de saleté', 'choice', NULL, NULL, NULL,
   '[{"code":"normal","label":"Normal","active":true},{"code":"heavy","label":"Important","active":true},{"code":"after_works","label":"Après travaux","active":true}]'::jsonb,
   true, '', true, now(), now())
ON CONFLICT DO NOTHING;

INSERT INTO "place_types" ("id", "category_id", "code", "name", "description", "icon", "display_order", "is_other", "area_parameter_id", "active", "created_at", "updated_at")
VALUES ('0192f1c4-de70-7000-8000-000000000b11', '0192f1c4-de70-7000-8000-000000000b01', 'villa', 'Villa', '[DÉMO] Maison individuelle avec cour.', 'villa', 0, false, '0192f1c4-de70-7000-8000-000000000d01', true, now(), now())
ON CONFLICT DO NOTHING;

-- Paramètres du lieu, dans l'ordre (R-CA-01) ; la superficie est le paramètre de surface (R-CA-14).
INSERT INTO "place_type_parameters" ("place_type_id", "parameter_id", "position")
VALUES
  ('0192f1c4-de70-7000-8000-000000000b11', '0192f1c4-de70-7000-8000-000000000d01', 0),
  ('0192f1c4-de70-7000-8000-000000000b11', '0192f1c4-de70-7000-8000-000000000d02', 1),
  ('0192f1c4-de70-7000-8000-000000000b11', '0192f1c4-de70-7000-8000-000000000d03', 2),
  ('0192f1c4-de70-7000-8000-000000000b11', '0192f1c4-de70-7000-8000-000000000d04', 3)
ON CONFLICT DO NOTHING;

INSERT INTO "cleaning_types" ("id", "code", "name", "description", "icon", "required_skill_code", "reference_duration_minutes", "checklist_template", "is_pack", "active", "created_at", "updated_at")
VALUES ('0192f1c4-de70-7000-8000-000000000e01', 'floor', 'Sol', '[DÉMO] Balayage et lavage des sols.', 'broom', 'indoor_cleaning', 180,
        '[{"code":"floors_swept","label":"Sols balayés","order":0},{"code":"floors_mopped","label":"Sols lavés","order":1}]'::jsonb,
        false, true, now(), now())
ON CONFLICT DO NOTHING;

-- Offre « Villa × Sol » (R-CA-03) ; règle d'équipe par tranches de superficie contiguës, la
-- dernière ouverte (R-CA-13).
INSERT INTO "offers" ("id", "place_type_id", "cleaning_type_id", "team_rule", "display_order", "active", "created_at", "updated_at")
VALUES ('0192f1c4-de70-7000-8000-000000000f01', '0192f1c4-de70-7000-8000-000000000b11', '0192f1c4-de70-7000-8000-000000000e01',
        '[{"fromArea":0,"toArea":100,"agents":2,"durationMinutes":180},{"fromArea":101,"toArea":null,"agents":3,"durationMinutes":240}]'::jsonb,
        0, true, now(), now())
ON CONFLICT DO NOTHING;

-- Tarif publié, version 1 (R-CA-07, R-CA-08), auteur fictif : base = superficie, minimum
-- 10 000 FCFA, remise récurrente par fréquence (R-PX-06).
INSERT INTO "tariff_versions" ("id", "offer_id", "version", "status", "base_parameter_id", "pack_discount_bp", "minimum_price", "frequency_coefficients", "created_at", "created_by", "published_at", "published_by")
VALUES ('0192f1c4-de70-7000-8000-000000001001', '0192f1c4-de70-7000-8000-000000000f01', 1, 'published', '0192f1c4-de70-7000-8000-000000000d01', NULL, 10000,
        '{"weekly":9000,"every_2_weeks":9500,"monthly":9800}'::jsonb,
        now(), '0192f1c4-de70-7000-8000-00000000ad01', now(), '0192f1c4-de70-7000-8000-00000000ad01')
ON CONFLICT DO NOTHING;

-- Tranches contiguës, bornes incluses ; au-delà de 400 m² : « sur devis » (R-PX-03).
INSERT INTO "tariff_brackets" ("id", "tariff_version_id", "from_value", "to_value", "mode", "amount")
VALUES
  ('0192f1c4-de70-7000-8000-000000001101', '0192f1c4-de70-7000-8000-000000001001', 0, 50, 'flat', 10000),
  ('0192f1c4-de70-7000-8000-000000001102', '0192f1c4-de70-7000-8000-000000001001', 51, 150, 'per_unit', 180),
  ('0192f1c4-de70-7000-8000-000000001103', '0192f1c4-de70-7000-8000-000000001001', 151, 400, 'per_unit', 150)
ON CONFLICT DO NOTHING;

-- Suppléments : cour + 5 000, chaque chambre au-delà de 3 + 1 500, « après travaux » × 1,3.
INSERT INTO "tariff_supplements" ("id", "tariff_version_id", "parameter_id", "choice_code", "mode", "amount", "coefficient_bp", "included_units", "position")
VALUES
  ('0192f1c4-de70-7000-8000-000000001201', '0192f1c4-de70-7000-8000-000000001001', '0192f1c4-de70-7000-8000-000000000d03', NULL, 'fixed', 5000, NULL, 0, 0),
  ('0192f1c4-de70-7000-8000-000000001202', '0192f1c4-de70-7000-8000-000000001001', '0192f1c4-de70-7000-8000-000000000d02', NULL, 'per_unit', 1500, NULL, 3, 1),
  ('0192f1c4-de70-7000-8000-000000001203', '0192f1c4-de70-7000-8000-000000001001', '0192f1c4-de70-7000-8000-000000000d04', 'after_works', 'coefficient', NULL, 13000, 0, 2)
ON CONFLICT DO NOTHING;

COMMIT;
