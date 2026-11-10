import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { NodeSDK, tracing } from '@opentelemetry/sdk-node';
import { maskSecretPaths } from '../logging/secret-paths';

/**
 * Hôtes dont les appels sortants ne sont jamais tracés : leur adresse porte des données
 * personnelles ou un secret (géocodage inverse : coordonnées du client dans la requête, clé
 * Google dans l'adresse, ADR-034). Une trace garderait l'URL complète (attribut `url.full`).
 */
export const UNTRACED_OUTGOING_HOSTS = ['maps.googleapis.com'] as const;

export interface TelemetryOptions {
  /** Hôtes de plus à ne pas tracer (par exemple celui de NOMINATIM_URL), noms d'hôte ou adresses. */
  untracedHosts?: readonly (string | undefined)[];
}

/** Nom d'hôte d'une adresse ou d'un nom d'hôte, en minuscules ; null si illisible ou vide. */
function hostOf(value: string | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  try {
    return new URL(text.includes('://') ? text : `http://${text}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Fonction « cet appel sortant ne doit pas être tracé », à partir de l'origine ou du nom d'hôte. */
export function untracedOutgoing(options: TelemetryOptions = {}): (target: string | undefined) => boolean {
  const hosts = new Set(
    [...UNTRACED_OUTGOING_HOSTS, ...(options.untracedHosts ?? [])]
      .map(hostOf)
      .filter((host): host is string => host !== null),
  );
  return (target) => {
    const host = hostOf(target);
    return host !== null && hosts.has(host);
  };
}

/** Configuration des instrumentations : fetch (undici) et http ignorent les hôtes non tracés. */
export function instrumentationConfig(options: TelemetryOptions = {}) {
  const ignored = untracedOutgoing(options);
  return {
    '@opentelemetry/instrumentation-fs': { enabled: false },
    '@opentelemetry/instrumentation-dns': { enabled: false },
    // fetch de Node : la requête porte son origine (« https://maps.googleapis.com »).
    '@opentelemetry/instrumentation-undici': {
      ignoreRequestHook: (request: { origin: string }) => ignored(request.origin),
    },
    '@opentelemetry/instrumentation-http': {
      ignoreOutgoingRequestHook: (request: { hostname?: string | null; host?: string | null }) =>
        ignored(request.hostname ?? request.host ?? undefined),
    },
  };
}

/** Attributs de span qui portent l'adresse d'une requête (conventions récentes et anciennes). */
const URL_ATTRIBUTES = ['url.full', 'url.path', 'http.url', 'http.target'] as const;

/**
 * Masque les jetons des adresses secrètes (lien de paiement, lien de signature) dans les attributs
 * des spans (ADR-051) : à la création (instrumentations http et NestJS) et juste avant la fin.
 */
export class SecretUrlSpanProcessor implements tracing.SpanProcessor {
  onStart(span: tracing.Span): void {
    this.mask(span);
  }

  onEnding(span: tracing.Span): void {
    this.mask(span);
  }

  onEnd(): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  private mask(span: tracing.Span): void {
    for (const key of URL_ATTRIBUTES) {
      const value = span.attributes[key];
      if (typeof value !== 'string') continue;
      const masked = maskSecretPaths(value) as string;
      if (masked !== value) span.setAttribute(key, masked);
    }
  }
}

/**
 * Démarre les traces OpenTelemetry (gRPC, HTTP, PostgreSQL, RabbitMQ…).
 * À appeler en tout premier dans main.ts, avant l'import de NestJS, pour que les bibliothèques soient instrumentées.
 * Sans OTEL_EXPORTER_OTLP_ENDPOINT, rien n'est démarré (tests, développement sans Jaeger).
 */
export function startTelemetry(
  serviceName: string,
  endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  options: TelemetryOptions = {},
): NodeSDK | undefined {
  if (!endpoint) return undefined;
  const sdk = new NodeSDK({
    serviceName,
    // Masquage d'abord, puis envoi par lots au collecteur.
    spanProcessors: [
      new SecretUrlSpanProcessor(),
      new tracing.BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint })),
    ],
    instrumentations: [getNodeAutoInstrumentations(instrumentationConfig(options))],
  });
  sdk.start();
  const shutdown = () => {
    void sdk.shutdown();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return sdk;
}
