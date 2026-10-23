-- ============================================================================================
-- DONNÉES DE DÉMONSTRATION — DÉVELOPPEMENT UNIQUEMENT. NE JAMAIS CHARGER EN PRÉPRODUCTION
-- NI EN PRODUCTION.
--
-- Prix INVENTÉS pour essayer le simulateur en local : ils ne viennent pas de l'équipe Nettoyage.
-- En production, la grille reste vide tant que l'équipe Nettoyage ne l'a pas remplie au
-- back-office (cahier des charges, partie 4).
--
-- Chargement, après les migrations, avec l'accord explicite ksp.demo=on :
--   PGOPTIONS='-c ksp.demo=on' psql postgresql://cleaning:cleaning@localhost:5432/cleaning \
--     -f services/cleaning/prisma/demo/demo-data.sql
-- Rejouable : les lignes existantes ne sont pas dupliquées.
-- ============================================================================================

DO $$
BEGIN
  IF coalesce(current_setting('ksp.demo', true), '') <> 'on' THEN
    RAISE EXCEPTION 'Données de démonstration refusées : développement uniquement (lancer avec ksp.demo=on).';
  END IF;
END $$;

INSERT INTO "cleaning_services" ("code", "name", "description", "unit", "active") VALUES
  ('office_cleaning', 'Nettoyage de bureaux', '[DÉMO] Bureaux, sanitaires et parties communes.', 'square_meter', true),
  ('home_cleaning', 'Nettoyage à domicile', '[DÉMO] Ménage complet du logement.', 'room', true),
  ('post_construction', 'Nettoyage de fin de chantier', '[DÉMO] Gravats fins, poussières, vitres.', 'square_meter', true),
  ('septic_emptying', 'Vidange', '[DÉMO] Vidange de fosse septique.', 'septic_tank', true),
  ('pest_control', 'Désinsectisation', '[DÉMO] Traitement contre les insectes.', 'square_meter', true)
ON CONFLICT ("code") DO NOTHING;

-- Grille de démonstration (version 1, auteur « demo »). Désinsectisation volontairement sans prix :
-- le simulateur doit répondre proprement.
INSERT INTO "pricing_rules"
  ("id", "service_code", "version", "unit_price", "minimum_price", "options", "commune_coefficients",
   "default_coefficient_bp", "team_size", "checklist", "created_by", "created_at")
VALUES
  ('0192f1c4-de70-7000-8000-000000000001', 'office_cleaning', 1, 300, 25000,
   '[{"code":"windows","label":"Vitres","price":10000},{"code":"weekend","label":"Intervention le week-end","price":15000}]',
   '{"cotonou":10000,"abomey-calavi":10500,"porto-novo":11000}', 10000,
   '{"unitsPerAgent":150,"minAgents":1,"maxAgents":8}', '[]', 'demo', now()),
  ('0192f1c4-de70-7000-8000-000000000002', 'home_cleaning', 1, 5000, 15000,
   '[{"code":"windows","label":"Vitres","price":4000},{"code":"furniture","label":"Mobilier","price":6000},{"code":"products","label":"Produits fournis","price":3000}]',
   '{"cotonou":10000,"abomey-calavi":10500}', 10000,
   '{"unitsPerAgent":3,"minAgents":1,"maxAgents":6}', '[]', 'demo', now()),
  ('0192f1c4-de70-7000-8000-000000000003', 'post_construction', 1, 600, 50000, '[]', '{}', 10000,
   '{"unitsPerAgent":100,"minAgents":2,"maxAgents":10}', '[]', 'demo', now()),
  ('0192f1c4-de70-7000-8000-000000000004', 'septic_emptying', 1, 45000, 45000, '[]', '{}', 10000,
   '{"unitsPerAgent":1,"minAgents":2,"maxAgents":3}', '[]', 'demo', now()),
  ('0192f1c4-de70-7000-8000-000000000005', 'pest_control', 1, NULL, NULL, '[]', '{}', 10000,
   '{"unitsPerAgent":200,"minAgents":1,"maxAgents":4}', '[]', 'demo', now())
ON CONFLICT ("service_code", "version") DO NOTHING;
