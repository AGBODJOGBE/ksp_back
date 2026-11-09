# Équivalent Windows de prepare-osrm.sh (ADR-045) : télécharge l'extrait OpenStreetMap du Bénin
# (Geofabrik) et prépare les données OSRM (profil car, algorithme MLD) dans le volume « osrm-data ».
#
#   powershell -ExecutionPolicy Bypass -File tools/geo/prepare-osrm.ps1
#   docker compose --profile routing up -d osrm      (ou « restart osrm » s'il tournait déjà)
#
# À relancer pour mettre la carte à jour. Autre extrait : $env:OSRM_EXTRACT_URL = '<adresse .osm.pbf>'.
$ErrorActionPreference = 'Stop'

Set-Location (Join-Path $PSScriptRoot '..\..')
$extractUrl = if ($env:OSRM_EXTRACT_URL) { $env:OSRM_EXTRACT_URL } else { 'https://download.geofabrik.de/africa/benin-latest.osm.pbf' }
$downloadDir = Join-Path ([IO.Path]::GetTempPath()) "ksp-osrm-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $downloadDir | Out-Null

# Outils d'OSRM lancés dans l'image du service osrm, avec son volume monté sur /data.
function Invoke-OsrmTool([string[]] $Arguments) {
  docker compose --profile routing run --rm --no-deps @Arguments
  if ($LASTEXITCODE -ne 0) { throw "docker compose run a échoué (code $LASTEXITCODE)." }
}

try {
  Write-Host "→ Téléchargement de $extractUrl"
  $ProgressPreference = 'SilentlyContinue' # la barre de progression ralentit fortement le téléchargement
  Invoke-WebRequest -Uri $extractUrl -OutFile (Join-Path $downloadDir 'region.osm.pbf') -UseBasicParsing

  Write-Host '→ Copie dans le volume osrm-data'
  Invoke-OsrmTool @('-v', "${downloadDir}:/download:ro", '--entrypoint', 'cp', 'osrm', '/download/region.osm.pbf', '/data/region.osm.pbf')

  Write-Host '→ osrm-extract (profil car)'
  Invoke-OsrmTool @('--entrypoint', 'osrm-extract', 'osrm', '-p', '/opt/car.lua', '/data/region.osm.pbf')
  Write-Host '→ osrm-partition'
  Invoke-OsrmTool @('--entrypoint', 'osrm-partition', 'osrm', '/data/region.osrm')
  Write-Host '→ osrm-customize'
  Invoke-OsrmTool @('--entrypoint', 'osrm-customize', 'osrm', '/data/region.osrm')

  Write-Host '✓ Données prêtes. Lancer : docker compose --profile routing up -d osrm'
}
finally {
  Remove-Item -Recurse -Force $downloadDir
}
