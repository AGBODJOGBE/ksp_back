# Service `geo`

Tout le géographique de la plateforme au même endroit (ADR-045) : géocodage inverse (commune d'un
point GPS) et itinéraires (distance, durée, matrice, point routier le plus proche) par OSRM.
Service **interne** : pas de route REST, appelé en gRPC par les services métier munis d'un jeton
de service d'audience `geo` (`cleaning` aujourd'hui ; `shop` et `delivery` ensuite). Ni base de
données ni événements. Contrat : `contracts/proto/ksp/geo/v1/geo.proto`.

## Démarrer en local

```bash
cp .env.example .env
pnpm --filter @ksp/geo-service dev
```

- gRPC : `localhost:50059`
- Santé : `http://localhost:3109/health/live` et `/health/ready`
- Métriques : `http://localhost:3109/metrics`

Le service démarre même sans OSRM : `Route`, `DistanceMatrix` et `Nearest` répondent alors
`GEO_ROUTING_UNAVAILABLE` (réessayable) et `ReverseGeocode` reste servi. Pour les itinéraires en
local, préparer puis lancer OSRM (voir le README racine, « Itinéraires (OSRM) »).

## Fonctionnement

- **ReverseGeocode** : Nominatim auto-hébergé (`NOMINATIM_URL`) puis Google Maps Geocoding
  (`GOOGLE_MAPS_API_KEY`) en secours, délai `GEOCODING_TIMEOUT_MS` par fournisseur (ADR-034). Rend
  les noms de commune possibles, l'adresse lisible et le fournisseur ; aucune erreur de
  fournisseur (réponse vide). Le rapprochement avec les zones desservies reste chez l'appelant.
- **Cache** des résultats trouvés, en mémoire et borné : `GEOCODING_CACHE_TTL_SECONDS` (1 heure,
  0 le désactive), `GEOCODING_CACHE_MAX_ENTRIES` (5 000, le moins récemment lu est oublié). Une
  position est géocodée deux fois par parcours du Nettoyage, et Google est payant. Propre à chaque
  réplique.
- **Route / DistanceMatrix / Nearest** : OSRM (`OSRM_URL`, algorithme MLD), délai
  `OSRM_TIMEOUT_MS` (2 s). Distances en mètres, durées en secondes, arrondies. Limites : 2 à 25
  points par itinéraire, 1 à 25 origines et destinations par matrice. Profil `car` seul :
  OSRM ne fournit pas de profil moto.
- **Confidentialité** : aucune coordonnée dans les journaux ; les appels vers Nominatim, Google
  et OSRM ne sont pas tracés (leur adresse porte la position).

## Organisation

| Dossier              | Contenu                                                        |
| -------------------- | -------------------------------------------------------------- |
| `src/domain`         | Point GPS, candidats de commune, profils et limites du routage |
| `src/application`    | Cas d'usage, validation des entrées, ports, erreurs            |
| `src/infrastructure` | Géocodeurs (Nominatim, Google, chaîne, cache), client OSRM     |
| `src/interfaces`     | Contrôleur gRPC                                                |
