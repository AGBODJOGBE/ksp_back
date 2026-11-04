-- ============================================================================================
-- DONNÉES DE DÉMONSTRATION — DÉVELOPPEMENT UNIQUEMENT. NE JAMAIS CHARGER EN PRÉPRODUCTION
-- NI EN PRODUCTION.
--
-- Prix INVENTÉS pour essayer le simulateur en local : ils ne viennent pas de l'équipe Nettoyage.
-- En production, les prix restent vides (null) tant que l'équipe Nettoyage ne les a pas saisis
-- au back-office (ADR-033).
--
-- Les prestations et leur formulaire sont créés par les migrations 0007 et 0008 (prix à null). Ce
-- script ajoute à cinq d'entre elles une version « demo » avec des prix ; la désinsectisation
-- reste volontairement sans prix : le simulateur doit répondre proprement (priced: false).
--
-- Chargement, après les migrations, avec l'accord explicite ksp.demo=on :
--   PGOPTIONS='-c ksp.demo=on' psql postgresql://cleaning:cleaning@localhost:5432/cleaning \
--     -f services/cleaning/prisma/demo/demo-data.sql
-- Rejouable : une prestation qui a déjà une version « demo » au nouveau modèle n'est pas modifiée.
-- ============================================================================================

DO $$
BEGIN
  IF coalesce(current_setting('ksp.demo', true), '') <> 'on' THEN
    RAISE EXCEPTION 'Données de démonstration refusées : développement uniquement (lancer avec ksp.demo=on).';
  END IF;
END $$;

-- Colonnes : identifiant, prestation, ancien prix unitaire (déduit), minimum, anciennes options
-- (déduites), coefficients de commune, taille d'équipe, champs, options, fréquences.
INSERT INTO "pricing_rules"
  ("id", "service_code", "version", "unit_price", "minimum_price", "options", "commune_coefficients",
   "default_coefficient_bp", "team_size", "checklist", "created_by", "created_at",
   "fields", "option_definitions", "frequencies")
SELECT
  d."id"::uuid, d."code", (SELECT COALESCE(MAX(p."version"), 0) + 1 FROM "pricing_rules" AS p WHERE p."service_code" = d."code"),
  d."unit_price", d."minimum_price", d."options", d."communes", 10000, d."team_size", '[]'::jsonb, 'demo', now(),
  d."fields", d."option_definitions", d."frequencies"
FROM (VALUES
  ('0192f1c4-de70-7000-8000-000000000016', 'garden_maintenance', 150, 15000, '[{"code":"hedge_trimming","label":"Taille de haies","price":null},{"code":"green_waste_removal","label":"Évacuation des déchets verts","price":10000}]'::jsonb, '{"cotonou":10000,"abomey-calavi":10500}'::jsonb, '{"fieldCode":"surface","unitsPerAgent":300,"minAgents":1,"maxAgents":6}'::jsonb, '[{"helpText":null,"unitLabel":"m²","min":1,"max":100000,"pricePerUnit":150,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"surface","label":"Superficie","type":"number","required":true,"active":true},{"helpText":null,"unitLabel":null,"min":null,"max":null,"pricePerUnit":null,"choices":[{"code":"maintained","label":"Entretenu","supplement":0,"coefficientBp":null,"active":true},{"code":"overgrown","label":"Envahi","supplement":null,"coefficientBp":13000,"active":true},{"code":"very_overgrown","label":"Très envahi","supplement":null,"coefficientBp":16000,"active":true}],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"condition","label":"État de la pelouse ou du jardin","type":"choice","required":true,"active":true}]'::jsonb, '[{"code":"hedge_trimming","label":"Taille de haies","description":null,"active":true,"flatPrice":null,"fields":[{"helpText":null,"unitLabel":"mètres linéaires","min":1,"max":5000,"pricePerUnit":500,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"hedge_length","label":"Longueur de haies","type":"number","required":true,"active":true}]},{"code":"green_waste_removal","label":"Évacuation des déchets verts","description":null,"active":true,"flatPrice":10000,"fields":[]}]'::jsonb, '[{"code":"once","label":"Une fois","coefficientBp":10000,"active":true},{"code":"weekly","label":"Chaque semaine","coefficientBp":8500,"active":true},{"code":"monthly","label":"Chaque mois","coefficientBp":9000,"active":true}]'::jsonb),
  ('0192f1c4-de70-7000-8000-000000000014', 'septic_emptying', 9000, 45000, '[{"code":"desludging","label":"Curage","price":25000}]'::jsonb, '{}'::jsonb, '{"fieldCode":"tank_volume","unitsPerAgent":10,"minAgents":2,"maxAgents":3}'::jsonb, '[{"helpText":null,"unitLabel":"m³","min":1,"max":200,"pricePerUnit":9000,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"tank_volume","label":"Volume de la fosse","type":"number","required":true,"active":true},{"helpText":null,"unitLabel":null,"min":null,"max":null,"pricePerUnit":null,"choices":[{"code":"septic_tank","label":"Fosse septique","supplement":0,"coefficientBp":null,"active":true},{"code":"cesspool","label":"Puisard","supplement":10000,"coefficientBp":null,"active":true}],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"tank_type","label":"Type de fosse","type":"choice","required":true,"active":true},{"helpText":null,"unitLabel":null,"min":null,"max":null,"pricePerUnit":null,"choices":[{"code":"easy","label":"Facile","supplement":0,"coefficientBp":null,"active":true},{"code":"difficult","label":"Difficile","supplement":null,"coefficientBp":12000,"active":true}],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"truck_access","label":"Accès du camion","type":"choice","required":true,"active":true}]'::jsonb, '[{"code":"desludging","label":"Curage","description":null,"active":true,"flatPrice":25000,"fields":[]}]'::jsonb, '[{"code":"once","label":"Une fois","coefficientBp":10000,"active":true}]'::jsonb),
  ('0192f1c4-de70-7000-8000-000000000012', 'home_cleaning', 5000, 15000, '[{"code":"windows","label":"Vitres","price":null},{"code":"sofa","label":"Canapé","price":null},{"code":"appliances","label":"Électroménager","price":6000}]'::jsonb, '{"cotonou":10000,"abomey-calavi":10500}'::jsonb, '{"fieldCode":"rooms","unitsPerAgent":3,"minAgents":1,"maxAgents":6}'::jsonb, '[{"helpText":null,"unitLabel":null,"min":null,"max":null,"pricePerUnit":null,"choices":[{"code":"studio","label":"Studio","supplement":0,"coefficientBp":null,"active":true},{"code":"apartment","label":"Appartement","supplement":0,"coefficientBp":null,"active":true},{"code":"villa","label":"Villa","supplement":5000,"coefficientBp":null,"active":true}],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"housing_type","label":"Type de logement","type":"choice","required":true,"active":true},{"helpText":null,"unitLabel":"pièces","min":1,"max":50,"pricePerUnit":5000,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"rooms","label":"Nombre de pièces","type":"number","required":true,"active":true},{"helpText":null,"unitLabel":"salles de bain","min":0,"max":20,"pricePerUnit":3000,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"bathrooms","label":"Nombre de salles de bain","type":"number","required":true,"active":true},{"helpText":null,"unitLabel":null,"min":null,"max":null,"pricePerUnit":null,"choices":[{"code":"normal","label":"Normal","supplement":0,"coefficientBp":null,"active":true},{"code":"dirty","label":"Sale","supplement":null,"coefficientBp":12000,"active":true},{"code":"very_dirty","label":"Très sale","supplement":null,"coefficientBp":15000,"active":true}],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"condition","label":"État du logement","type":"choice","required":true,"active":true},{"helpText":null,"unitLabel":null,"min":null,"max":null,"pricePerUnit":null,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":11000,"code":"pets","label":"Présence d''animaux","type":"boolean","required":false,"active":true}]'::jsonb, '[{"code":"windows","label":"Vitres","description":null,"active":true,"flatPrice":null,"fields":[{"helpText":null,"unitLabel":"fenêtres","min":1,"max":200,"pricePerUnit":500,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"window_count","label":"Nombre de fenêtres","type":"number","required":true,"active":true}]},{"code":"sofa","label":"Canapé","description":null,"active":true,"flatPrice":null,"fields":[{"helpText":null,"unitLabel":"places","min":1,"max":20,"pricePerUnit":2000,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"seats","label":"Nombre de places","type":"number","required":true,"active":true}]},{"code":"appliances","label":"Électroménager","description":null,"active":true,"flatPrice":6000,"fields":[]}]'::jsonb, '[{"code":"once","label":"Une fois","coefficientBp":10000,"active":true},{"code":"weekly","label":"Chaque semaine","coefficientBp":9000,"active":true},{"code":"monthly","label":"Chaque mois","coefficientBp":9500,"active":true}]'::jsonb),
  ('0192f1c4-de70-7000-8000-000000000011', 'office_cleaning', 300, 25000, '[{"code":"windows","label":"Vitres","price":null},{"code":"carpet","label":"Moquette","price":null}]'::jsonb, '{"cotonou":10000,"abomey-calavi":10500,"porto-novo":11000}'::jsonb, '{"fieldCode":"surface","unitsPerAgent":150,"minAgents":1,"maxAgents":8}'::jsonb, '[{"helpText":null,"unitLabel":"m²","min":1,"max":100000,"pricePerUnit":300,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"surface","label":"Superficie","type":"number","required":true,"active":true},{"helpText":null,"unitLabel":"sanitaires","min":0,"max":200,"pricePerUnit":2000,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"restrooms","label":"Nombre de sanitaires","type":"number","required":true,"active":true},{"helpText":null,"unitLabel":null,"min":null,"max":null,"pricePerUnit":null,"choices":[{"code":"normal","label":"Normal","supplement":0,"coefficientBp":null,"active":true},{"code":"dirty","label":"Sale","supplement":null,"coefficientBp":12000,"active":true},{"code":"very_dirty","label":"Très sale","supplement":null,"coefficientBp":15000,"active":true}],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"condition","label":"État des locaux","type":"choice","required":true,"active":true}]'::jsonb, '[{"code":"windows","label":"Vitres","description":null,"active":true,"flatPrice":null,"fields":[{"helpText":null,"unitLabel":"fenêtres","min":1,"max":1000,"pricePerUnit":400,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"window_count","label":"Nombre de fenêtres","type":"number","required":true,"active":true}]},{"code":"carpet","label":"Moquette","description":null,"active":true,"flatPrice":null,"fields":[{"helpText":null,"unitLabel":"m²","min":1,"max":100000,"pricePerUnit":500,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"carpet_surface","label":"Surface de moquette","type":"number","required":true,"active":true}]}]'::jsonb, '[{"code":"once","label":"Une fois","coefficientBp":10000,"active":true},{"code":"weekly","label":"Chaque semaine","coefficientBp":9000,"active":true},{"code":"monthly","label":"Chaque mois","coefficientBp":9500,"active":true}]'::jsonb),
  ('0192f1c4-de70-7000-8000-000000000013', 'post_construction', 600, 50000, '[{"code":"rubble_removal","label":"Évacuation des gravats","price":null},{"code":"windows","label":"Vitres","price":null}]'::jsonb, '{}'::jsonb, '{"fieldCode":"surface","unitsPerAgent":100,"minAgents":2,"maxAgents":10}'::jsonb, '[{"helpText":null,"unitLabel":"m²","min":1,"max":100000,"pricePerUnit":600,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"surface","label":"Superficie","type":"number","required":true,"active":true},{"helpText":null,"unitLabel":"niveaux","min":1,"max":50,"pricePerUnit":5000,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"floors","label":"Nombre de niveaux","type":"number","required":true,"active":true},{"helpText":null,"unitLabel":null,"min":null,"max":null,"pricePerUnit":null,"choices":[{"code":"light","label":"Léger","supplement":0,"coefficientBp":null,"active":true},{"code":"medium","label":"Moyen","supplement":null,"coefficientBp":12500,"active":true},{"code":"heavy","label":"Lourd","supplement":null,"coefficientBp":15000,"active":true}],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"condition","label":"État du chantier","type":"choice","required":true,"active":true}]'::jsonb, '[{"code":"rubble_removal","label":"Évacuation des gravats","description":null,"active":true,"flatPrice":null,"fields":[{"helpText":null,"unitLabel":"m³","min":1,"max":500,"pricePerUnit":15000,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"rubble_volume","label":"Volume de gravats","type":"number","required":true,"active":true}]},{"code":"windows","label":"Vitres","description":null,"active":true,"flatPrice":null,"fields":[{"helpText":null,"unitLabel":"fenêtres","min":1,"max":1000,"pricePerUnit":500,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"window_count","label":"Nombre de fenêtres","type":"number","required":true,"active":true}]}]'::jsonb, '[{"code":"once","label":"Une fois","coefficientBp":10000,"active":true},{"code":"weekly","label":"Chaque semaine","coefficientBp":10000,"active":true},{"code":"monthly","label":"Chaque mois","coefficientBp":10000,"active":true}]'::jsonb)
) AS d ("id", "code", "unit_price", "minimum_price", "options", "communes", "team_size", "fields", "option_definitions", "frequencies")
WHERE EXISTS (SELECT 1 FROM "cleaning_services" AS s WHERE s."code" = d."code")
  AND NOT EXISTS (
    SELECT 1 FROM "pricing_rules" AS p
    WHERE p."service_code" = d."code" AND p."created_by" = 'demo' AND p."fields" <> '[]'::jsonb
  );

UPDATE "cleaning_services" SET "description" = '[DÉMO] ' || "description"
WHERE "code" IN ('garden_maintenance', 'septic_emptying', 'home_cleaning', 'office_cleaning', 'post_construction', 'pest_control')
  AND "description" NOT LIKE '[DÉMO]%';

-- --------------------------------------------------------------------------------------------
-- Parcours par lieu (ADR-034) : de quoi essayer le back-office et le portail en local.
-- Coordonnées FICTIVES, arrondies, autour de lieux publics de Cotonou ; client fictif.
-- --------------------------------------------------------------------------------------------

-- Prestation désactivée (pour un type de lieu qui la référence encore) : elle reste masquée.
INSERT INTO "cleaning_services" ("code", "name", "description", "unit", "active")
VALUES ('demo_sofa_cleaning', 'Nettoyage de canapés', '[DÉMO] Prestation désactivée.', 'square_meter', false)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "pricing_rules"
  ("id", "service_code", "version", "unit_price", "minimum_price", "options", "commune_coefficients",
   "default_coefficient_bp", "team_size", "checklist", "created_by", "created_at",
   "fields", "option_definitions", "frequencies")
VALUES (
  '0192f1c4-de70-7000-8000-000000000021', 'demo_sofa_cleaning', 1, NULL, NULL, '[]'::jsonb, '{}'::jsonb, 10000,
  '{"fieldCode":"seats","unitsPerAgent":10,"minAgents":1,"maxAgents":2}'::jsonb, '[]'::jsonb, 'demo-places', now(),
  '[{"helpText":null,"unitLabel":"places","min":1,"max":50,"pricePerUnit":null,"choices":[],"supplementIfYes":null,"coefficientBpIfYes":null,"code":"seats","label":"Nombre de places","type":"number","required":true,"active":true}]'::jsonb,
  '[]'::jsonb,
  '[{"code":"once","label":"Une fois","coefficientBp":10000,"active":true}]'::jsonb
)
ON CONFLICT ("id") DO NOTHING;

-- Un type de lieu désactivé, et un type qui référence une prestation désactivée.
INSERT INTO "place_types" ("code", "label", "description", "icon", "display_order", "active", "service_codes", "updated_by", "updated_at") VALUES
  ('demo_shop', 'Boutique', '[DÉMO] Type de lieu désactivé.', 'shop', 60, false,
   ARRAY['office_cleaning', 'window_cleaning'], 'demo', now()),
  ('demo_lounge', 'Salon de réception', '[DÉMO] Référence une prestation désactivée.', 'sofa', 70, true,
   ARRAY['demo_sofa_cleaning', 'window_cleaning'], 'demo', now())
ON CONFLICT ("code") DO NOTHING;

-- Groupe de 3 demandes (Maison, près de la place de l'Étoile rouge) : reçue, visite planifiée,
-- acceptée (mission avec position). Commune trouvée par Nominatim.
INSERT INTO "quote_request_groups" ("id", "customer_id", "idempotency_key", "place_type", "commune", "created_at")
VALUES ('0192f1c4-de70-7000-8000-0000000a0001', '0192f1c4-de70-7000-8000-0000000c0001', 'demo-group-1', 'house', 'Cotonou', '2026-11-02T09:00:00Z')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "quote_requests"
  ("id", "customer_id", "idempotency_key", "status", "customer_kind", "service_code", "premises_type", "quantity",
   "options", "commune", "commune_code", "address", "preferred_slots", "recommended_team_size",
   "answers", "option_selections", "frequency", "pricing_version",
   "group_id", "place_type", "latitude", "longitude", "location_accuracy_m", "landmark", "geocoding_provider",
   "geocoded_address", "created_at", "updated_at")
VALUES
  ('0192f1c4-de70-7000-8000-0000000b0001', '0192f1c4-de70-7000-8000-0000000c0001', 'group:0192f1c4-de70-7000-8000-0000000a0001:0',
   'received', 'individual', 'house_cleaning', 'other', 4, '{}', 'Cotonou', 'cotonou',
   'Près de la place de l''Étoile rouge, portail vert (repère fictif)',
   '[{"start":"2026-11-20T08:00:00.000Z","end":"2026-11-20T11:00:00.000Z"}]'::jsonb, 2,
   '{"surface":180,"bedrooms":4,"bathrooms":2,"front_yard":true,"back_yard":false,"condition":"normal"}'::jsonb, '[]'::jsonb, 'once', 1,
   '0192f1c4-de70-7000-8000-0000000a0001', 'house', 6.3654, 2.4183, 12, 'Près de la place de l''Étoile rouge, portail vert (repère fictif)', 'nominatim',
   'Place de l''Étoile rouge, Cotonou, Littoral, Bénin', '2026-11-02T09:00:00Z', '2026-11-02T09:00:00Z'),
  ('0192f1c4-de70-7000-8000-0000000b0002', '0192f1c4-de70-7000-8000-0000000c0001', 'group:0192f1c4-de70-7000-8000-0000000a0001:1',
   'visit_scheduled', 'individual', 'garden_maintenance', 'other', 250, '{}', 'Cotonou', 'cotonou',
   'Près de la place de l''Étoile rouge, portail vert (repère fictif)',
   '[{"start":"2026-11-20T08:00:00.000Z","end":"2026-11-20T11:00:00.000Z"}]'::jsonb, 1,
   '{"surface":250,"condition":"overgrown"}'::jsonb, '[]'::jsonb, 'once', 1,
   '0192f1c4-de70-7000-8000-0000000a0001', 'house', 6.3654, 2.4183, 12, 'Près de la place de l''Étoile rouge, portail vert (repère fictif)', 'nominatim',
   'Place de l''Étoile rouge, Cotonou, Littoral, Bénin', '2026-11-02T09:00:00Z', '2026-11-03T10:00:00Z'),
  ('0192f1c4-de70-7000-8000-0000000b0003', '0192f1c4-de70-7000-8000-0000000c0001', 'group:0192f1c4-de70-7000-8000-0000000a0001:2',
   'accepted', 'individual', 'septic_emptying', 'other', 6, '{}', 'Cotonou', 'cotonou',
   'Près de la place de l''Étoile rouge, portail vert (repère fictif)',
   '[{"start":"2026-11-20T08:00:00.000Z","end":"2026-11-20T11:00:00.000Z"}]'::jsonb, 2,
   '{"tank_volume":6,"tank_type":"septic_tank","truck_access":"easy"}'::jsonb, '[]'::jsonb, 'once', 1,
   '0192f1c4-de70-7000-8000-0000000a0001', 'house', 6.3654, 2.4183, 12, 'Près de la place de l''Étoile rouge, portail vert (repère fictif)', 'nominatim',
   'Place de l''Étoile rouge, Cotonou, Littoral, Bénin', '2026-11-02T09:00:00Z', '2026-11-04T08:00:00Z')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "site_visits" ("id", "request_id", "status", "scheduled_at", "agent_id")
VALUES ('0192f1c4-de70-7000-8000-0000000d0001', '0192f1c4-de70-7000-8000-0000000b0002', 'scheduled', '2026-11-10T09:00:00Z', '0192f1c4-de70-7000-8000-0000000f0001')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "quotes"
  ("id", "request_id", "lines", "subtotal", "intervention_count", "total", "proposed_slots", "valid_until",
   "deposit_percent", "deposit_amount", "team_size", "duration_minutes", "sent_at")
VALUES ('0192f1c4-de70-7000-8000-0000000d0002', '0192f1c4-de70-7000-8000-0000000b0003',
  '[{"label":"Volume de la fosse","quantity":6,"unitPrice":9000,"amount":54000}]'::jsonb, 54000, 1, 54000,
  '[{"start":"2026-11-20T08:00:00.000Z","end":"2026-11-20T11:00:00.000Z"}]'::jsonb, '2026-11-18T08:00:00Z',
  30, 16200, 2, 180, '2026-11-03T08:00:00Z')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "missions"
  ("id", "request_id", "quote_id", "acceptance_key", "customer_id", "status", "service_code", "commune", "address",
   "chosen_slot_start", "chosen_slot_end", "planned_interventions", "payment_plan", "payment_total",
   "deposit_percent", "deposit_amount", "latitude", "longitude", "location_accuracy_m", "landmark", "group_id",
   "place_type", "created_at", "updated_at")
VALUES ('0192f1c4-de70-7000-8000-0000000e0001', '0192f1c4-de70-7000-8000-0000000b0003', '0192f1c4-de70-7000-8000-0000000d0002',
  'demo-accept-1', '0192f1c4-de70-7000-8000-0000000c0001', 'to_schedule', 'septic_emptying', 'Cotonou',
  'Près de la place de l''Étoile rouge, portail vert (repère fictif)', '2026-11-20T08:00:00Z', '2026-11-20T11:00:00Z', 1,
  '{"option":"full","timing":"after","method":"cash"}'::jsonb, 54000, 30, 16200, 6.3654, 2.4183, 12,
  'Près de la place de l''Étoile rouge, portail vert (repère fictif)', '0192f1c4-de70-7000-8000-0000000a0001', 'house',
  '2026-11-04T08:00:00Z', '2026-11-04T08:00:00Z')
ON CONFLICT ("id") DO NOTHING;

UPDATE "quote_requests"
SET "current_quote_id" = '0192f1c4-de70-7000-8000-0000000d0002', "mission_id" = '0192f1c4-de70-7000-8000-0000000e0001'
WHERE "id" = '0192f1c4-de70-7000-8000-0000000b0003' AND "mission_id" IS NULL;

-- Demande dont la commune a été choisie à la main (aucun fournisseur n'a répondu), près du
-- stade de l'Amitié.
INSERT INTO "quote_request_groups" ("id", "customer_id", "idempotency_key", "place_type", "commune", "created_at")
VALUES ('0192f1c4-de70-7000-8000-0000000a0002', '0192f1c4-de70-7000-8000-0000000c0001', 'demo-group-2', 'apartment', 'Cotonou', '2026-11-03T15:00:00Z')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "quote_requests"
  ("id", "customer_id", "idempotency_key", "status", "customer_kind", "service_code", "premises_type", "quantity",
   "options", "commune", "commune_code", "address", "preferred_slots", "recommended_team_size",
   "answers", "option_selections", "frequency", "pricing_version",
   "group_id", "place_type", "latitude", "longitude", "landmark", "geocoding_provider", "geocoded_address",
   "created_at", "updated_at")
VALUES ('0192f1c4-de70-7000-8000-0000000b0004', '0192f1c4-de70-7000-8000-0000000c0001', 'group:0192f1c4-de70-7000-8000-0000000a0002:0',
  'received', 'individual', 'window_cleaning', 'other', 12, '{}', 'Cotonou', 'cotonou',
  'Immeuble face au stade de l''Amitié, 3e étage (repère fictif)',
  '[{"start":"2026-11-21T08:00:00.000Z","end":"2026-11-21T10:00:00.000Z"}]'::jsonb, 1,
  '{"window_count":12,"access":"at_height"}'::jsonb, '[]'::jsonb, 'once', 1,
  '0192f1c4-de70-7000-8000-0000000a0002', 'apartment', 6.3790, 2.3790,
  'Immeuble face au stade de l''Amitié, 3e étage (repère fictif)', NULL, NULL,
  '2026-11-03T15:00:00Z', '2026-11-03T15:00:00Z')
ON CONFLICT ("id") DO NOTHING;

-- Demande ancienne, antérieure au parcours par lieu : ni groupe, ni lieu, ni position.
INSERT INTO "quote_requests"
  ("id", "customer_id", "idempotency_key", "status", "customer_kind", "service_code", "premises_type", "quantity",
   "options", "commune", "commune_code", "address", "preferred_slots", "recommended_team_size", "created_at", "updated_at")
VALUES ('0192f1c4-de70-7000-8000-0000000b0005', '0192f1c4-de70-7000-8000-0000000c0001', 'demo-old-1',
  'received', 'individual', 'home_cleaning', 'apartment', 3, '{}', 'Abomey-Calavi', 'abomey-calavi',
  'Lot 12, Abomey-Calavi (adresse fictive)',
  '[{"start":"2026-11-22T08:00:00.000Z","end":"2026-11-22T11:00:00.000Z"}]'::jsonb, 1,
  '2026-10-20T09:00:00Z', '2026-10-20T09:00:00Z')
ON CONFLICT ("id") DO NOTHING;

-- Visite technique commune (ADR-035) : la maison et le jardin du premier groupe sont visités ensemble,
-- même heure, même agent (identifiant de visite commune partagé). Rejouable.
INSERT INTO "site_visits" ("id", "request_id", "status", "scheduled_at", "agent_id", "group_visit_id")
VALUES ('0192f1c4-de70-7000-8000-0000000d0003', '0192f1c4-de70-7000-8000-0000000b0001', 'scheduled', '2026-11-10T09:00:00Z',
  '0192f1c4-de70-7000-8000-0000000f0001', '0192f1c4-de70-7000-8000-0000000e0001')
ON CONFLICT ("id") DO NOTHING;
UPDATE "site_visits" SET "group_visit_id" = '0192f1c4-de70-7000-8000-0000000e0001'
WHERE "id" = '0192f1c4-de70-7000-8000-0000000d0001' AND "group_visit_id" IS NULL;
UPDATE "quote_requests" SET "status" = 'visit_scheduled'
WHERE "id" = '0192f1c4-de70-7000-8000-0000000b0001' AND "status" = 'received';
