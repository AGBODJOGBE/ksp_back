import { ConfigError, loadConfig } from '@ksp/platform';
import { Test } from '@nestjs/testing';
import { AppModule, settingsOf } from '../src/app.module';
import { configSchema } from '../src/config';
import {
  DocumentGrpcController,
  DocumentInternalGrpcController,
  DocumentSigningGrpcController,
} from '../src/interfaces/grpc/document.controllers';

const base = {
  SERVICE_NAME: 'document',
  NODE_ENV: 'test',
  GRPC_PORT: '50057',
  HTTP_PORT: '3107',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  RABBITMQ_URL: 'amqp://localhost',
  DOCUMENT_CODE_HMAC_SECRET: 'test-only-hmac-secret-0123456789abcdef',
  DOCUMENT_EXPIRY_INTERVAL_MS: '0',
};

describe('AppModule', () => {
  it('assemble toutes les dépendances du service', async () => {
    const config = loadConfig(configSchema, base);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] }).compile();
    expect(moduleRef.get(DocumentInternalGrpcController)).toBeDefined();
    expect(moduleRef.get(DocumentGrpcController)).toBeDefined();
    expect(moduleRef.get(DocumentSigningGrpcController)).toBeDefined();
    await moduleRef.close();
  });
});

describe('configuration', () => {
  it('ouvre le modèle de test hors production, avec les réglages par défaut', () => {
    const settings = settingsOf(loadConfig(configSchema, { ...base, PORTAL_BASE_URL: 'https://ksp.bj/' }));
    expect(settings.genericTemplateEnabled).toBe(true);
    expect(settings.portalBaseUrl).toBe('https://ksp.bj');
    expect(settings.internalCallers).toEqual(['recovery', 'cleaning', 'billing']);
    expect(settings.codePolicy).toEqual({
      length: 6,
      ttlSeconds: 600,
      maxAttempts: 5,
      resendDelaySeconds: 60,
      maxPerHour: 5,
    });
  });

  it('refuse une clé HMAC trop courte', () => {
    expect(() => loadConfig(configSchema, { ...base, DOCUMENT_CODE_HMAC_SECRET: 'court' })).toThrow(
      ConfigError,
    );
  });

  it('production : modèle de test interdit, HTTPS et jeton de service obligatoires', () => {
    const production = {
      ...base,
      NODE_ENV: 'production',
      IDENTITY_JWKS_URL: 'http://identity:3101/.well-known/jwks.json',
    };
    expect(() =>
      loadConfig(configSchema, { ...production, DOCUMENT_GENERIC_TEMPLATE_ENABLED: 'true' }),
    ).toThrow(/modèle de test/);
    expect(() => loadConfig(configSchema, { ...production, PORTAL_BASE_URL: 'http://ksp.bj' })).toThrow(
      /HTTPS/,
    );
    expect(() => loadConfig(configSchema, production)).toThrow(/Jeton de service/);
    const ok = loadConfig(configSchema, {
      ...production,
      IDENTITY_TOKEN_URL: 'http://identity:3101/oauth/token',
      SERVICE_CLIENT_SECRET: 'secret',
    });
    expect(settingsOf(ok).genericTemplateEnabled).toBe(false);
  });
});
