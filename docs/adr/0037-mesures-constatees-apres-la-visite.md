# ADR-037 — Mesures constatées après la visite technique, recalcul du prix et réponses lisibles

**Statut** : Proposé (lot 2 ; besoin validé par le responsable le 2026-11-05 ; complète l'ADR-033 et l'ADR-035 sans les modifier)

## Contexte

La visite des lieux est obligatoire avant tout devis (décision du 2026-10-23). Sur place, l'agent constate souvent des dimensions différentes de celles déclarées par le client (huit pièces au lieu de six, logement très sale). Aujourd'hui, le compte rendu n'est qu'un texte : le devis est prérempli depuis le calcul fait avec les réponses du client (ADR-033 point 6) et le superviseur doit recalculer à la main. Le back-office affiche en outre les réponses de façon peu lisible (« Type de locaux : Autre, Quantité 2 ») : les codes des champs et des choix ne sont pas traduits en libellés.

Contraintes : contrats par ajout seulement (`buf breaking`) ; l'ADR-033 garde les réponses du client, la version de grille et le détail du calcul de la demande, qui servent d'historique ; l'ADR-035 ouvre le compte rendu (par demande et commun) à l'agent affecté ; montants entiers en XOF ; rien de personnel dans le journal d'audit.

## Décision

1. **Recalcul sans enregistrement** : `POST /api/v1/admin/cleaning/quote-requests/{id}/estimate` (`CleaningAdminService/EstimateRequestPrice`). Corps `{ answers, options, frequency }` au nouveau format seulement (ADR-033 point 4), validé comme une simulation (`CLEANING_VALIDATION_FAILED`, `details.field` = `answers.<champ>`, `details.reason`). Calcul identique à la simulation (`calculatePrice`) avec la **commune de la demande**, la **grille en vigueur** de sa prestation (même désactivée) et la taille d'équipe demandée par le client. Réponse : `requestId`, `serviceCode`, `commune`, `calculation` (prix ou `priced: false` avec `reason` et `missingPrices`, lignes, taille d'équipe). Rien n'est enregistré ni tracé.
2. **Mesures constatées** : mêmes champs que le formulaire du client, au nouveau format, validées de la même façon, avec leur calcul (règle du point 1), la version de grille, la date et l'auteur. Elles sont enregistrées **à part** (`measured_answers`, `measured_option_selections`, `measured_frequency`, `measured_calculation`, `measured_pricing_version`, `measured_at`, `measured_by` ; migration `0010_visit_measurements`, colonnes nulles) : les réponses du client et leur calcul ne sont jamais remplacés. Chaque saisie est tracée (`request.measured` : source, remplacement, version, prix, saisie par un agent), sans adresse ni réponse.
   - **Au compte rendu** : `CompleteVisit` accepte `measurements { answers, options, frequency }` facultatif ; le compte rendu commun accepte `measurements [{ requestId, answers, options, frequency }]` pour les demandes de la visite commune (une demande hors de la visite ou citée deux fois : `details.field` = `measurements[i].requestId`). Erreurs préfixées (`measurements.answers.rooms`, `measurements[1].answers.surface`) ; une erreur n'enregistre rien (tout ou rien pour la visite commune).
   - **Après la visite** : `PUT /api/v1/admin/cleaning/quote-requests/{id}/measurements` (`SaveRequestMeasurements`) enregistre ou remplace les mesures.
   - **Droits** : supervision (`cleaning_supervisor`, `cleaning_admin`, `super_admin`), ou agent affecté à la visite de la demande (planifiée ou faite) ; un autre agent : `CLEANING_REQUEST_NOT_FOUND`. Double authentification comme les routes voisines. Même règle pour le recalcul.
   - **Verrou** : mesures acceptées seulement pour une demande reçue ou à visite planifiée (y compris une nouvelle visite demandée après l'envoi d'un devis, qui devra être renvoyé) ; sinon `CLEANING_MEASUREMENTS_LOCKED` (422, `details.status`).
3. **Devis prérempli** (`SendQuote` et envoi groupé, sans lignes) : depuis le calcul des mesures s'il existe, sinon depuis celui de la demande (ADR-033 point 6, inchangé). Calcul des mesures sans prix : nouveau calcul avec la grille en vigueur et les réponses mesurées ; toujours sans prix : `CLEANING_PRICE_NOT_SET`. Sans `teamSize`, la taille d'équipe recommandée par le calcul des mesures. La trace `quote.sent` indique l'origine des lignes (`prefilledFrom` : `measurement` ou `request`).
4. **Réponses lisibles** : chaque demande présentée porte `answerSummary` (client et back-office) et, au back-office, `measuredSummary` : champs dans l'ordre du formulaire `{ code, label, type, value, display, unitLabel }` (libellé du choix, « Oui » / « Non », nombre et unité, « 12 500 m² »), options `{ optionCode, label, fields }`, fréquence `{ code, label }`. Libellés résolus avec **la version de grille utilisée** par le calcul (nouvelle lecture `CatalogRepository.findServiceVersion`), la version en vigueur à défaut ; un code inconnu sert de libellé. Demande à l'ancien format (sans réponses enregistrées) : « Type de locaux » (Appartement, Maison, Bureau, Commerce, Entrepôt, Autre) et « Quantité » avec l'ancienne unité de la prestation. `placeTypeLabel` et `serviceName` (ADR-034) inchangés.
5. **Espace client** : ni les mesures ni leur résumé ne sont présentés au client (champs `null`) ; il voit ses réponses lisibles et, ensuite, le devis.
6. **Contrats, par ajout seulement** :
   - gRPC : RPC `EstimateRequestPrice`, `SaveRequestMeasurements` ; messages `RequestMeasurement`, `AnswerSummary`, `AnswerSummaryField`, `AnswerSummaryOption`, `AnswerSummaryFrequency`, `MeasurementInput`, `RequestMeasurementInput` ; champs `QuoteRequest.measurement` (41), `answer_summary` (42), `measured_summary` (43), `CompleteVisitRequest.measurements` (3), `CompleteGroupVisitRequest.measurements` (4) ; erreur `CLEANING_MEASUREMENTS_LOCKED`.
   - REST : routes `estimateCleaningQuoteRequest` et `saveCleaningMeasurements` ; `measurements` facultatif dans les deux comptes rendus (schéma propre `CompleteCleaningGroupVisitRequest` pour la visite commune) ; `CleaningQuoteRequest` reçoit `answerSummary`, `measuredAnswers`, `measuredOptions`, `measuredFrequency`, `measuredCalculation`, `measuredPricingVersion`, `measuredAt`, `measuredBy`, `measuredByName`, `measuredSummary` (à plat, comme `answers` et `calculation`).
   - Événements : aucun changement.

## Alternatives écartées

- **Remplacer les réponses du client par les mesures** : perte de l'historique (ce que le client a déclaré, au prix affiché par le simulateur) et des litiges impossibles à trancher.
- **Recalculer au moment du devis seulement** : le superviseur ne verrait pas le prix avant d'envoyer, et l'agent ne pourrait pas annoncer un ordre de grandeur sur place.
- **Mesures modifiables après l'envoi du devis** : le devis envoyé ne correspondrait plus aux mesures affichées ; une nouvelle visite rouvre la saisie.
- **Résumé lisible calculé par les fronts** : chaque front devrait lire la bonne version de grille (non publique pour les éléments désactivés) ; cleaning la connaît déjà.
- **Montrer les mesures au client avant le devis** : le prix des mesures n'est pas encore celui du devis (lignes modifiables par le superviseur).

## Conséquences

- `cleaning` : domaine `answer-summary.ts` (résumés, ancien format), `Measurement` sur la demande ; cas d'usage `EstimateRequestPrice`, `SaveMeasurements`, compte rendu (par demande et commun) avec mesures, préremplissage du devis ; lecture d'une version de grille ; présentations (audience back-office ou client).
- `gateway` : deux routes au manifeste, schémas zod, adaptateur et présentateurs (mesures à plat, résumés).
- Back-office : écran « Après la visite » (formulaire prérempli, prix recalculé à chaque modification, enregistrement des mesures, devis prérempli) ; portail : affichage de `answerSummary`.
- Complément du 2026-11-06 : l'agent n'ouvre pas la fiche d'une demande ; `GET /api/v1/admin/cleaning/visits` (`VisitedRequest`, champs 6 à 15 par ajout) porte donc, pour chaque demande, le type de lieu, les réponses du client (`answers`, `selectedOptions`, `frequency`, `pricingVersion`, `answerSummary`) et les mesures (`measured*`, `measuredSummary`) ; pour `cleaning_agent` seul, aucun montant (`calculation` et `measuredCalculation` à `null`), le recalcul restant ouvert ; le masquage de la position (ADR-035) s'applique toujours.
- Complément du 2026-11-06 (règle des montants) : un agent de terrain seul, sans rôle de supervision, ne voit jamais les montants commerciaux d'une demande (`calculation`, `estimate`, `quote`, `measuredCalculation` à `null`) dans aucune réponse du back-office : liste des visites, compte rendu (par demande et commun), enregistrement des mesures, correction de position ; seul `POST …/quote-requests/{id}/estimate` lui renvoie le calcul, car c'est son outil de saisie et il doit y voir l'effet de ses mesures.

## À valider

- Saisie des mesures par la supervision possible avant la visite faite (seul le devis exige une visite réalisée).
- Taille d'équipe par défaut du devis reprise du calcul des mesures.
- Mesures et leur résumé jamais montrés au client.
- Un oui/non sans réponse n'apparaît pas dans le résumé (« Non » seulement s'il est répondu).
- Libellés de l'ancien format (« Type de locaux », « Quantité », « Commerce » pour `shop`).
