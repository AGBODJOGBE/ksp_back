// Chargé en premier par main.ts : les traces doivent être actives avant le chargement de NestJS et de gRPC.
import { startTelemetry } from '@ksp/platform/telemetry';

// Les adresses appelées vers Nominatim, Google et OSRM portent les coordonnées (et la clé Google) :
// ces appels ne sont pas tracés (ADR-034, ADR-045).
startTelemetry('geo', process.env.OTEL_EXPORTER_OTLP_ENDPOINT, {
  untracedHosts: [process.env.NOMINATIM_URL, process.env.OSRM_URL],
});
