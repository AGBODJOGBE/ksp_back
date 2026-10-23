// Chargé en premier par main.ts : les traces doivent être actives avant le chargement de NestJS et de gRPC.
import { startTelemetry } from '@ksp/platform/telemetry';

startTelemetry('cleaning');
