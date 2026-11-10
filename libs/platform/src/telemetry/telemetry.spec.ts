import { tracing } from '@opentelemetry/sdk-node';
import { instrumentationConfig, SecretUrlSpanProcessor, startTelemetry, untracedOutgoing } from './telemetry';

describe('traces : appels sortants non tracés (ADR-034)', () => {
  it('Google Maps n’est jamais tracé : coordonnées et clé sont dans l’adresse', () => {
    const ignored = untracedOutgoing();
    expect(ignored('https://maps.googleapis.com')).toBe(true);
    expect(ignored('maps.googleapis.com')).toBe(true);
    expect(ignored('https://MAPS.googleapis.com:443')).toBe(true);
    expect(ignored('https://sandbox-api.fedapay.com')).toBe(false);
    expect(ignored(undefined)).toBe(false);
    expect(ignored('')).toBe(false);
  });

  it('hôte de Nominatim ajouté depuis son adresse, adresse vide ignorée', () => {
    const ignored = untracedOutgoing({ untracedHosts: ['http://nominatim.internal:8080/', '', undefined] });
    expect(ignored('http://nominatim.internal:8080')).toBe(true);
    expect(ignored('nominatim.internal')).toBe(true);
    expect(ignored('http://identity:50051')).toBe(false);
  });

  it('fetch (undici) et http ignorent ces hôtes, les autres restent tracés', () => {
    const config = instrumentationConfig({ untracedHosts: ['http://nominatim:8080'] });
    const undici = config['@opentelemetry/instrumentation-undici'].ignoreRequestHook;
    const http = config['@opentelemetry/instrumentation-http'].ignoreOutgoingRequestHook;
    expect(undici({ origin: 'https://maps.googleapis.com' })).toBe(true);
    expect(undici({ origin: 'http://nominatim:8080' })).toBe(true);
    expect(undici({ origin: 'https://api.fedapay.com' })).toBe(false);
    expect(http({ hostname: 'maps.googleapis.com' })).toBe(true);
    expect(http({ host: 'nominatim' })).toBe(true);
    expect(http({ hostname: 'localhost' })).toBe(false);
    expect(config['@opentelemetry/instrumentation-fs'].enabled).toBe(false);
  });

  it('sans adresse de collecte, rien n’est démarré', () => {
    expect(startTelemetry('test', '')).toBeUndefined();
  });
});

describe('traces : jetons des adresses masqués (ADR-051)', () => {
  const token = 'Pq4vQ0b4H1m0w2nY5p7r9t1v3x5z7B9D1F3H5J7L9Nq';

  it('jeton d’un lien de paiement ou de signature : jamais dans les attributs exportés', async () => {
    const exporter = new tracing.InMemorySpanExporter();
    const provider = new tracing.BasicTracerProvider({
      spanProcessors: [new SecretUrlSpanProcessor(), new tracing.SimpleSpanProcessor(exporter)],
    });
    const tracer = provider.getTracer('test');
    // Attributs posés à la création par l'instrumentation http (url.path) et NestJS (url.full)…
    const span = tracer.startSpan('GET', {
      attributes: {
        'url.path': `/api/v1/payment/links/${token}/pay`,
        'url.full': `/api/v1/document/sign/${token}`,
        'http.route': '/api/v1/payment/links/:token/pay',
      },
    });
    // … ou plus tard.
    span.setAttribute('http.target', `/api/v1/payment/links/${token}`);
    span.end();
    await provider.forceFlush();

    const [exported] = exporter.getFinishedSpans();
    expect(JSON.stringify(exported?.attributes)).not.toContain(token);
    expect(exported?.attributes).toMatchObject({
      'url.path': '/api/v1/payment/links/[masqué]/pay',
      'url.full': '/api/v1/document/sign/[masqué]',
      'http.target': '/api/v1/payment/links/[masqué]',
      'http.route': '/api/v1/payment/links/:token/pay',
    });
    await provider.shutdown();
  });
});
