#!/usr/bin/env sh
# Prépare les données d'itinéraires OSRM du service geo (ADR-045) dans le volume « osrm-data » de
# docker compose : téléchargement de l'extrait OpenStreetMap du Bénin (Geofabrik), puis
# osrm-extract (profil car), osrm-partition et osrm-customize (algorithme MLD).
#
#   tools/geo/prepare-osrm.sh
#   docker compose --profile routing up -d osrm      (ou « restart osrm » s'il tournait déjà)
#
# À relancer pour mettre la carte à jour. Autre extrait : OSRM_EXTRACT_URL=<adresse .osm.pbf>.
set -eu

cd "$(dirname "$0")/../.."
EXTRACT_URL="${OSRM_EXTRACT_URL:-https://download.geofabrik.de/africa/benin-latest.osm.pbf}"
DOWNLOAD_DIR="$(mktemp -d)"
trap 'rm -rf "$DOWNLOAD_DIR"' EXIT

# Outils d'OSRM lancés dans l'image du service osrm, avec son volume monté sur /data.
osrm_run() {
  docker compose --profile routing run --rm --no-deps "$@"
}

echo "→ Téléchargement de $EXTRACT_URL"
curl -fL --retry 3 -o "$DOWNLOAD_DIR/region.osm.pbf" "$EXTRACT_URL"

echo "→ Copie dans le volume osrm-data"
osrm_run -v "$DOWNLOAD_DIR:/download:ro" --entrypoint cp osrm /download/region.osm.pbf /data/region.osm.pbf

echo "→ osrm-extract (profil car)"
osrm_run --entrypoint osrm-extract osrm -p /opt/car.lua /data/region.osm.pbf
echo "→ osrm-partition"
osrm_run --entrypoint osrm-partition osrm /data/region.osrm
echo "→ osrm-customize"
osrm_run --entrypoint osrm-customize osrm /data/region.osrm

echo "✓ Données prêtes. Lancer : docker compose --profile routing up -d osrm"
