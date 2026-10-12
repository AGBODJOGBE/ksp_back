import { z } from 'zod';
import { baseServiceConfigSchema, ConfigError, loadConfig } from './config';

const validEnv = {
  SERVICE_NAME: 'identity',
  GRPC_PORT: '50051',
  HTTP_PORT: '3001',
  DATABASE_URL: 'postgresql://identity:secret@localhost:5432/identity',
  RABBITMQ_URL: 'amqp://ksp:ksp@localhost:5672',
};

describe('loadConfig', () => {
  it('convertit les ports en nombres et applique les valeurs par défaut', () => {
    const cfg = loadConfig(baseServiceConfigSchema, validEnv);
    expect(cfg.GRPC_PORT).toBe(50051);
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.LOG_LEVEL).toBe('info');
    expect(cfg.SERVICE_TOKEN_ISSUER).toBe('ksp-identity');
  });

  it('liste toutes les variables invalides dans un message lisible', () => {
    expect(() =>
      loadConfig(baseServiceConfigSchema, { ...validEnv, GRPC_PORT: 'abc', DATABASE_URL: '' }),
    ).toThrow(ConfigError);
    try {
      loadConfig(baseServiceConfigSchema, { ...validEnv, GRPC_PORT: 'abc', DATABASE_URL: '' });
    } catch (error) {
      expect((error as Error).message).toContain('GRPC_PORT');
      expect((error as Error).message).toContain('DATABASE_URL');
    }
  });

  it('refuse la production sans clés publiques pour les jetons de service', () => {
    expect(() => loadConfig(baseServiceConfigSchema, { ...validEnv, NODE_ENV: 'production' })).toThrow(
      /IDENTITY_JWKS_URL/,
    );
  });

  it('accepte un schéma étendu par un service', () => {
    const schema = baseServiceConfigSchema.safeExtend({ OTP_TTL_SECONDS: z.coerce.number().default(300) });
    expect(loadConfig(schema, validEnv).OTP_TTL_SECONDS).toBe(300);
  });
});
