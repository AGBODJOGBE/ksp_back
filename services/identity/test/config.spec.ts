import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '@ksp/platform';
import { configSchema, DEV_SECRETS } from '../src/config';

/** Valeur d'une variable dans le .env.example du service (valeurs de développement). */
function example(name: string): string {
  const line = readFileSync(join(__dirname, '..', '.env.example'), 'utf8')
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} absent du .env.example`);
  return line.slice(name.length + 1);
}

const production = {
  SERVICE_NAME: 'identity',
  NODE_ENV: 'production',
  GRPC_PORT: '50051',
  HTTP_PORT: '3101',
  DATABASE_URL: 'postgresql://identity:secret@db:5432/identity',
  RABBITMQ_URL: 'amqp://rabbitmq',
  IDENTITY_JWKS_URL: 'http://identity:3101/.well-known/jwks.json',
  NOTIFICATION_GRPC_URL: 'dns:///notification-headless:50052',
  OTP_HMAC_SECRET: 'secret-de-production-du-coffre-0123456789',
  IDENTITY_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describe('configuration en production (ADR-050)', () => {
  it('connaît les secrets de développement du .env.example', () => {
    for (const [name, value] of Object.entries(DEV_SECRETS)) expect(example(name)).toBe(value);
  });

  it('refuse les secrets de développement du .env.example', () => {
    expect(() =>
      loadConfig(configSchema, { ...production, OTP_HMAC_SECRET: example('OTP_HMAC_SECRET') }),
    ).toThrow(/OTP_HMAC_SECRET/);
    expect(() =>
      loadConfig(configSchema, {
        ...production,
        IDENTITY_MFA_ENCRYPTION_KEY: example('IDENTITY_MFA_ENCRYPTION_KEY'),
      }),
    ).toThrow(/IDENTITY_MFA_ENCRYPTION_KEY/);
  });

  it('accepte des secrets propres à la production ; le développement garde ceux du .env.example', () => {
    expect(loadConfig(configSchema, production).NODE_ENV).toBe('production');
    const development = loadConfig(configSchema, {
      ...production,
      NODE_ENV: 'development',
      OTP_HMAC_SECRET: example('OTP_HMAC_SECRET'),
      IDENTITY_MFA_ENCRYPTION_KEY: example('IDENTITY_MFA_ENCRYPTION_KEY'),
    });
    expect(development.NODE_ENV).toBe('development');
  });
});
