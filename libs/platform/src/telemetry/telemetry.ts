import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { NodeSDK } from '@opentelemetry/sdk-node';

/**
 * Démarre les traces OpenTelemetry (gRPC, HTTP, PostgreSQL, RabbitMQ…).
 * À appeler en tout premier dans main.ts, avant l'import de NestJS, pour que les bibliothèques soient instrumentées.
 * Sans OTEL_EXPORTER_OTLP_ENDPOINT, rien n'est démarré (tests, développement sans Jaeger).
 */
export function startTelemetry(
  serviceName: string,
  endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
): NodeSDK | undefined {
  if (!endpoint) return undefined;
  const sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
      }),
    ],
  });
  sdk.start();
  const shutdown = () => {
    void sdk.shutdown();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return sdk;
}
