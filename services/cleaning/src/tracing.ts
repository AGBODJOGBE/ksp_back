// Chargé en premier par main.ts : les traces doivent être actives avant le chargement de NestJS et de gRPC.
import { startTelemetry } from '@ksp/platform/telemetry';

// Plus d'appel direct à Nominatim ni à Google (ADR-059) : les positions passent à geo dans le
// corps gRPC, jamais dans une adresse tracée.
startTelemetry('cleaning', process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
