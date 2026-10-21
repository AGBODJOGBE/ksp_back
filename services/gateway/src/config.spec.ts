import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, loadConfig } from '@ksp/platform';
import { configSchema, rateLimitsFrom, trustProxyFrom } from './config';

const PRODUCTION = {
  NODE_ENV: 'production',
  IDENTITY_JWKS_URL: 'http://identity:3101/.well-known/jwks.json',
  IDENTITY_TOKEN_URL: 'http://identity:3101/oauth/token',
  SERVICE_CLIENT_SECRET: 'secret',
  TRUST_PROXY: '10.42.0.0/16',
  CORS_WEB_ORIGINS: 'https://ksp.bj, https://shop.ksp.bj,https://print.ksp.bj',
  CORS_BACKOFFICE_ORIGINS: 'https://admin.ksp.bj',
};

describe('configuration de la gateway', () => {
  it('démarre en développement sans aucune variable, avec les valeurs du cahier des charges', () => {
    const config = loadConfig(configSchema, {});
    expect(config).toMatchObject({
      SERVICE_NAME: 'gateway',
      HTTP_PORT: 3000,
      GRPC_DEADLINE_MS: 3000,
      MAX_BODY_BYTES: 1024 * 1024,
      JWKS_CACHE_TTL_SECONDS: 600,
      REFRESH_COOKIE_INSECURE: false,
      CORS_WEB_ORIGINS: [],
    });
    expect(rateLimitsFrom(config).otp_request).toEqual({ limit: 5, windowSeconds: 60, key: 'ip' });
    expect(trustProxyFrom(config)).toBe('loopback');
  });

  it('accepte une configuration de production complète', () => {
    const config = loadConfig(configSchema, PRODUCTION);
    expect(config.CORS_WEB_ORIGINS).toEqual([
      'https://ksp.bj',
      'https://shop.ksp.bj',
      'https://print.ksp.bj',
    ]);
    expect(trustProxyFrom({ ...config, TRUST_PROXY: '2' })).toBe(2);
  });

  it('règle les limites par configuration', () => {
    const config = loadConfig(configSchema, { RATE_LIMIT_OTP_REQUEST_PER_MINUTE: '3' });
    expect(rateLimitsFrom(config).otp_request.limit).toBe(3);
  });

  it.each([
    ['sans adresse JWKS', { IDENTITY_JWKS_URL: undefined }, 'IDENTITY_JWKS_URL'],
    ['sans secret de service', { SERVICE_CLIENT_SECRET: undefined }, 'SERVICE_CLIENT_SECRET'],
    ['sans mandataires de confiance', { TRUST_PROXY: undefined }, 'TRUST_PROXY'],
    ['avec un cookie non sécurisé', { REFRESH_COOKIE_INSECURE: 'true' }, 'REFRESH_COOKIE_INSECURE'],
    ['sans origines', { CORS_BACKOFFICE_ORIGINS: '' }, 'CORS_WEB_ORIGINS'],
    ['avec une origine HTTP', { CORS_WEB_ORIGINS: 'http://ksp.bj' }, 'Origine non HTTPS'],
  ])('refuse de démarrer en production %s', (_label, change, message) => {
    expect(() => loadConfig(configSchema, { ...PRODUCTION, ...change })).toThrow(ConfigError);
    expect(() => loadConfig(configSchema, { ...PRODUCTION, ...change })).toThrow(message);
  });

  it('le fichier .env.example est accepté tel quel (variables vides = absentes)', () => {
    const env = Object.fromEntries(
      readFileSync(join(__dirname, '..', '.env.example'), 'utf8')
        .split('\n')
        .filter((line) => /^[A-Z_]+=/.test(line))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    const config = loadConfig(configSchema, env);
    expect(config.IDENTITY_TOKEN_URL).toBeUndefined();
    expect(config.SERVICE_CLIENT_SECRET).toBeUndefined();
    expect(config.CORS_BACKOFFICE_ORIGINS).toEqual(['http://localhost:3040']);
  });

  it('refuse une origine avec un chemin', () => {
    expect(() => loadConfig(configSchema, { CORS_WEB_ORIGINS: 'https://ksp.bj/app' })).toThrow(ConfigError);
  });
});
