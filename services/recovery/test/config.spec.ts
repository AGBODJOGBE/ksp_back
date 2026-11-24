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

const key = (fill: number) => Buffer.alloc(32, fill).toString('base64');

const production = {
  SERVICE_NAME: 'recovery',
  NODE_ENV: 'production',
  GRPC_PORT: '50060',
  HTTP_PORT: '3110',
  DATABASE_URL: 'postgresql://recovery:secret@db:5432/recovery',
  RABBITMQ_URL: 'amqp://rabbitmq',
  IDENTITY_JWKS_URL: 'http://identity:3101/.well-known/jwks.json',
  IDENTITY_TOKEN_URL: 'http://identity:3101/oauth/token',
  SERVICE_CLIENT_SECRET: 'secret-du-service-fourni-par-le-coffre',
  IDENTITY_GRPC_URL: 'dns:///identity-headless:50051',
  NOTIFICATION_GRPC_URL: 'dns:///notification-headless:50052',
  PAYMENT_GRPC_URL: 'dns:///payment-headless:50055',
  FILE_GRPC_URL: 'dns:///file-headless:50056',
  WALLET_GRPC_URL: 'dns:///wallet-headless:50057',
  DOCUMENT_GRPC_URL: 'dns:///document-headless:50058',
  RECOVERY_PII_ENCRYPTION_KEYS: key(1),
  RECOVERY_BLIND_INDEX_KEYS: key(2),
  RECOVERY_DEBTOR_BASE_URL: 'https://ksp.bj/recouvrement',
  RECOVERY_DEBTOR_CODE_HMAC_SECRET: 'secret-de-production-du-coffre-0123456789',
};

describe('configuration de l’accès du débiteur (ADR-061, ADR-050)', () => {
  it('connaît le secret de développement du .env.example', () => {
    for (const [name, value] of Object.entries(DEV_SECRETS)) expect(example(name)).toBe(value);
  });

  it('accepte une configuration de production complète', () => {
    expect(loadConfig(configSchema, production)).toMatchObject({
      RECOVERY_DEBTOR_BASE_URL: 'https://ksp.bj/recouvrement',
      RECOVERY_DEBTOR_CODE_HMAC_SECRET: production.RECOVERY_DEBTOR_CODE_HMAC_SECRET,
    });
  });

  it.each([
    ['la valeur du .env.example', example('RECOVERY_DEBTOR_CODE_HMAC_SECRET')],
    ['une valeur vide (secret de développement par défaut)', ''],
    ['un secret trop court', 'trop-court'],
  ])('refuse en production la clé des codes : %s', (_label, value) => {
    expect(() =>
      loadConfig(configSchema, { ...production, RECOVERY_DEBTOR_CODE_HMAC_SECRET: value }),
    ).toThrow(/RECOVERY_DEBTOR_CODE_HMAC_SECRET/);
  });

  it('refuse en production une adresse du lien sans HTTPS', () => {
    expect(() =>
      loadConfig(configSchema, { ...production, RECOVERY_DEBTOR_BASE_URL: 'http://ksp.bj/recouvrement' }),
    ).toThrow(/RECOVERY_DEBTOR_BASE_URL/);
  });

  it('hors production : clé de développement et page locale du portail par défaut', () => {
    const config = loadConfig(configSchema, {
      SERVICE_NAME: 'recovery',
      NODE_ENV: 'test',
      GRPC_PORT: '50060',
      HTTP_PORT: '3110',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      RABBITMQ_URL: 'amqp://localhost',
    });
    expect(config.RECOVERY_DEBTOR_CODE_HMAC_SECRET).toBe(DEV_SECRETS.RECOVERY_DEBTOR_CODE_HMAC_SECRET);
    expect(config.RECOVERY_DEBTOR_BASE_URL).toBe('http://localhost:3010/recouvrement');
  });
});
