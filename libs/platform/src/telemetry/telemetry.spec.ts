import { instrumentationConfig, startTelemetry, untracedOutgoing } from './telemetry';

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
