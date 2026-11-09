# ADR-045 — Service interne `geo` : géocodage inverse et itinéraires OSRM

**Statut** : Proposé (2026-11-09)

## Contexte

Le Nettoyage retrouve la commune d'un point GPS par géocodage inverse (ADR-034 : Nominatim
auto-hébergé puis Google, dans `cleaning`). Demain, le Shop et la Livraison auront besoin des
positions des boutiques et des livreurs, de distances, de durées et de frais de livraison. Le
responsable déploie **OSRM** (moteur d'itinéraires) et veut tout le géographique au même endroit.

OSRM et le géocodage sont deux besoins distincts : OSRM calcule des itinéraires (distance, durée,
matrice, accrochage au réseau routier) mais ne dit pas dans quelle commune se trouve un point ; la
commune vient toujours de Nominatim (Google en secours).

## Décision

1. **Nouveau service `geo`** (`pnpm new-service`, gRPC 50059, HTTP 3109), **interne** : aucune route
   REST, aucune entrée dans l'OpenAPI ni le manifeste de la gateway. Il est appelé en gRPC par les
   services métier munis d'un jeton de service d'audience `geo` (ADR-022) ; l'autorisation est
   l'entrée de l'appelant dans `SERVICE_CLIENTS` d'identity (cleaning, puis shop et delivery), sans
   liste d'appelants en plus dans `geo`. **Ni base de données ni événements** : `DATABASE_URL` et
   `RABBITMQ_URL`, exigées par le kit, reçoivent une valeur jamais utilisée.
2. **Contrat** `ksp.geo.v1.GeoService` :
   - `ReverseGeocode(point)` → noms de commune possibles (ordonnés, sans doublon), adresse lisible,
     fournisseur. La chaîne d'ADR-034 est **déplacée telle quelle** (mêmes clés, même délai
     `GEOCODING_TIMEOUT_MS` par fournisseur, même repli, même journal sans coordonnées) ; jamais
     d'erreur de fournisseur (réponse vide). Le rapprochement commune → zone desservie reste chez
     l'appelant : les zones lui appartiennent.
   - `Route(points, profil)` → distance (m) et durée (s) ; `DistanceMatrix(origines, destinations,
profil)` → une cellule par couple (`reachable`, distance, durée) ; `Nearest(point, profil)` →
     point du réseau routier, distance, nom de la voie. OSRM `/route`, `/table`, `/nearest`.
   - Entiers arrondis (mètres, secondes) ; 2 à 25 points par itinéraire, 1 à 25 origines et
     destinations par matrice (50 points, sous la limite par défaut d'OSRM de 100).
   - Profil en texte, `car` par défaut (vide). **`car` seul** : OSRM ne fournit pas de profil moto ;
     un nouveau profil s'ajoutera sans changer le contrat.
   - Erreurs : `GEO_VALIDATION_FAILED` (bornes du globe, nombre de points, profil ; `details.field`),
     `GEO_ROUTE_NOT_FOUND` et `GEO_POINT_NOT_ROUTABLE` (NOT_FOUND), `GEO_ROUTING_UNAVAILABLE`
     (UNAVAILABLE, réessayable : OSRM absent, en panne, trop lent ou réponse inattendue). Le Bénin
     est attendu mais un point hors du pays n'est pas refusé.
3. **Disponibilité** : `geo` démarre et reste « prêt » sans OSRM (`OSRM_URL` vide ou injoignable) ;
   seul le routage répond `GEO_ROUTING_UNAVAILABLE`, le géocodage est toujours servi. Délai par
   appel `OSRM_TIMEOUT_MS` (2 s).
4. **Cache** en mémoire, borné, des seuls résultats de géocodage trouvés (`GEOCODING_CACHE_TTL_SECONDS`
   1 h, `GEOCODING_CACHE_MAX_ENTRIES` 5 000, le moins récemment lu est oublié ; clé : position au
   millionième de degré). Le parcours du Nettoyage géocode deux fois la même position et Google est
   payant. Pas de cache des itinéraires (OSRM local et rapide). Cache propre à chaque réplique.
5. **Confidentialité** (ADR-034, point 7) : aucune coordonnée dans les journaux ni dans les messages
   d'erreur ; les appels vers Nominatim, Google **et OSRM** ne sont pas tracés (leur adresse porte la
   position) ; les positions du cache ne vivent qu'en mémoire.
6. **Le Nettoyage passe par `geo` sans changer de comportement** : son port `ReverseGeocoder` reste ;
   l'adaptateur `GeoServiceGeocoder` est choisi quand `GEO_GRPC_URL` est renseignée (jeton de service
   d'audience `geo`, délai `2 × GEOCODING_TIMEOUT_MS + 1 s`, sans nouvelle tentative puisque `geo`
   enchaîne déjà ses fournisseurs ; panne = « non trouvé », le client choisit sa commune). Sans
   `GEO_GRPC_URL`, les adaptateurs d'ADR-034 sont appelés directement : ils sont gardés en **repli**,
   marqués comme tels, et seront retirés une fois `geo` déployé partout.
7. **Infrastructure OSRM** : service `osrm` dans `docker-compose.yml` (profil `routing`, pour ne pas
   bloquer `pnpm infra:up` tant que les données manquent), image officielle
   `ghcr.io/project-osrm/osrm-backend:v6.0.0` — `osrm/osrm-backend` sur Docker Hub n'est plus
   publiée depuis 2021 (v5.25.0). `tools/geo/prepare-osrm.sh` (et `.ps1`) télécharge l'extrait
   Geofabrik du Bénin et lance `osrm-extract` (profil car), `osrm-partition` et `osrm-customize`
   (algorithme MLD) dans le volume `osrm-data`.

## Alternatives écartées

- **Géocodage par OSRM** : il ne fait pas de géocodage inverse.
- **Géocodage et routage dans chaque service métier** : clés Google, délais, cache et règles de
  confidentialité dupliqués dans cleaning, shop et delivery.
- **Exposer `geo` à la gateway** : les fronts n'ont pas besoin d'itinéraires bruts ; chaque métier
  publie ce qui le concerne (commune et zone, frais de livraison) avec ses propres règles.
- **Profil moto approximé par `car`** : durées fausses pour les livreurs à moto ; mieux vaut un vrai
  profil plus tard qu'une valeur trompeuse aujourd'hui.
- **Sonde de disponibilité sur OSRM** : `geo` serait retiré du trafic quand OSRM tombe, coupant aussi
  le géocodage.

## Conséquences

- Shop et Livraison utiliseront `Route` (distance et durée d'une course, base des frais),
  `DistanceMatrix` (livreurs ou boutiques les plus proches, tournées) et `Nearest` (point d'accès
  routier d'une boutique ou d'un client), et `ReverseGeocode` pour la commune de livraison.
- Déploiement : `geo` avant de renseigner `GEO_GRPC_URL` dans cleaning ; ajouter `geo` aux audiences
  de cleaning dans `SERVICE_CLIENTS` d'identity ; `NOMINATIM_URL` et `GOOGLE_MAPS_API_KEY` passent
  de cleaning à `geo`. Préparer les données OSRM sur le serveur (même script) et les remettre à jour
  périodiquement.
- Reste à faire : **Nominatim auto-hébergé** à installer (données de l'Afrique de l'Ouest) ; **profil
  moto** (profil Lua dérivé de `car.lua`, second jeu de données et second `osrm-routed`, profil
  `motorbike` ajouté au service) ; retrait des adaptateurs de repli de cleaning ; mise à jour
  automatique de la carte. **Hors périmètre** : suivi des livreurs en temps réel (positions en
  continu, WebSocket), calcul des frais de livraison (règle métier de delivery).
