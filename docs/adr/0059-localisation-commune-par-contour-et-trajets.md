# ADR-059 — Localisation : commune par contour officiel, temps de trajet par OSRM

**Statut** : Proposé (2026-11-19)

## Contexte

En v1, la commune d'un lieu vient du **géocodage inverse** : Nominatim puis Google donnent des noms
(ville, commune, département…), rapprochés des zones desservies avec des **noms alternatifs** pour
rattraper les écarts d'orthographe (ADR-034, décision 6 ; chaîne déplacée dans `geo` par ADR-045). Le
résultat dépend du fournisseur et de son orthographe ; Google est payant. ADR-034 avait écarté les
contours des communes (données à produire et à maintenir). Pour la planification, le temps de trajet
était une durée fixe de 30 minutes, alors que `geo` sait déjà calculer une matrice de durées OSRM
(ADR-045).

Le cahier des charges v2 tranche : R-ZN-01 (commune = contour officiel qui contient le point, 77
communes du Bénin stockées dans `geo`) et R-ZN-02 (temps de trajet OSRM, profil voiture, 30 min par
défaut si indisponible).

## Décision

1. **Commune par contour** (R-ZN-01) : nouvelle RPC interne `geo.ResolveCommune(point)` → clé de
   commune, nom officiel, département ; ou « hors de toute commune ». Test d'appartenance du point aux
   contours officiels des **77 communes**, chargés en mémoire au démarrage depuis un fichier de données
   versionné dans le dépôt (source et date indiquées), avec un index par rectangle englobant. `geo`
   reste sans base de données (ADR-045). Un point sur une limite est attribué de façon déterministe (la
   plus petite clé).
2. **Clé de commune** stable, fournie par `geo` et reprise telle quelle par `cleaning` (`Zone.commune_key`)
   et par `identity` (portée `zone`, ADR-057). `geo.ListCommunes` rend la liste des 77 communes : l'admin
   crée une zone en choisissant une commune, jamais en tapant un nom.
3. **Refus hors zone** : un point hors de tout contour, ou dans une commune non desservie, est refusé
   (`CLEANING_ZONE_NOT_COVERED`). Plus de repli sur une commune tapée par le client ni de rapprochement
   par nom.
4. **Adresse lisible seulement** : `ReverseGeocode` (Nominatim, puis Google en secours) ne sert plus
   qu'à proposer une adresse lisible ; son échec ne bloque rien. Google reste un secours payant, appelé
   seulement quand Nominatim ne trouve pas.
5. **Temps de trajet** (R-ZN-02) : `geo.DistanceMatrix`, profil `car`, entre le lieu de l'affectation
   précédente (ou suivante) et celui de l'affectation contrôlée (ADR-058). OSRM indisponible
   (`GEO_ROUTING_UNAVAILABLE`) ou trajet introuvable : réglage « temps de trajet » (30 min par défaut,
   0 à 120). Le contrôle indique quand la valeur par défaut a servi.
6. **Arrivée sur place** (partie 10, R-VI-04) : distance entre la position envoyée par l'agent et celle
   du lieu calculée dans le domaine de `cleaning` (formule de haversine) ; au-delà de 300 m, alerte au
   superviseur, sans blocage. Aucun service extérieur.
7. **Confidentialité inchangée** (ADR-034 décision 7, ADR-045 décision 5) : positions chiffrées en base
   (partie 16.3), jamais dans les journaux, traces, événements ni messages d'erreur ; positions passées
   à `geo` dans le corps gRPC, appels sortants non tracés.

## Alternatives écartées

- **Géocodage inverse pour la commune** (v1) : réponse dépendante du fournisseur et de l'orthographe,
  noms alternatifs à entretenir, appel payant en secours ; le contour donne une réponse exacte,
  instantanée, gratuite et sans appel extérieur.
- **Contours dans une base PostGIS** : une base de plus pour 77 polygones qui changent rarement.
- **Google Maps comme base** (autocomplétion d'adresses) : adresses du Bénin pauvres, coût au-delà du
  quota gratuit ; au Bénin, la position GPS et le point de repère servent davantage.
- **Durée fixe de 30 minutes** : Calavi → Porto-Novo n'est pas Akpakpa → Cadjehoun ; le planning doit
  refléter la vraie distance.

## Conséquences

- `geo` : fichier des contours (quelques mégaoctets une fois simplifié), chargement et index au
  démarrage, `ResolveCommune` et `ListCommunes` (ajouts au contrat `ksp.geo.v1`).
- `cleaning` : port `CommuneResolver` à la place du rapprochement par noms ; adaptateurs Nominatim et
  Google gardés en repli direct (ADR-045 décision 6) retirés.
- OSRM ne connaît que la voiture : les durées seront un peu pessimistes en ville tant qu'un profil moto
  n'est pas ajouté (sans changer le contrat, ADR-045).
- Nominatim reste à installer sur le serveur ; le service public d'OpenStreetMap suffit en développement
  (dans le respect de ses conditions d'usage).
- ADR-034 (décision 6) et ADR-045 (rôle du géocodage pour la commune, décision 6) sont remplacés en
  partie.

## À valider

- Source des contours officiels (IGN Bénin, ou jeu publié à partir de ses données) et sa licence ;
  forme de la clé de commune (code officiel de la source, ou nom normalisé).
- Noms alternatifs des zones : la partie 15.1 les garde (`Zone.aliases`) ; proposition : simples noms
  d'affichage et de recherche, sans rôle dans la résolution de la commune.
- Précision GPS faible près d'une limite de commune : aucun traitement particulier (le point fait foi).
