// Chargé en premier par main.ts : les traces doivent être actives avant le chargement de NestJS et de gRPC.
import { startTelemetry } from '@ksp/platform/telemetry';

// Géocodage inverse (ADR-034) : les appels vers Nominatim et Google ne sont pas tracés (coordonnées
// du client et clé dans l'adresse).
startTelemetry('cleaning', process.env.OTEL_EXPORTER_OTLP_ENDPOINT, {
  untracedHosts: [process.env.NOMINATIM_URL],
});
