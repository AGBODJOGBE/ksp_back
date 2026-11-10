import { loadConfig } from '@ksp/platform';
import { Test } from '@nestjs/testing';
import { AppModule, createPayoutProvider, createProvider } from '../src/app.module';
import { configSchema } from '../src/config';
import {
  PaymentAdminGrpcController,
  PaymentGrpcController,
  PaymentWebhookGrpcController,
} from '../src/interfaces/grpc/payment.controllers';

const BASE = {
  SERVICE_NAME: 'payment',
  NODE_ENV: 'test',
  GRPC_PORT: '50055',
  HTTP_PORT: '3105',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  RABBITMQ_URL: 'amqp://localhost',
};

describe('AppModule', () => {
  it('assemble toutes les dépendances du service', async () => {
    const config = loadConfig(configSchema, { ...BASE, PAYMENT_RECONCILE_INTERVAL_MS: '0' });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] }).compile();
    expect(moduleRef.get(PaymentGrpcController)).toBeDefined();
    expect(moduleRef.get(PaymentWebhookGrpcController)).toBeDefined();
    expect(moduleRef.get(PaymentAdminGrpcController)).toBeDefined();
    await moduleRef.close();
  });
});

describe('configuration de payment', () => {
  it('prestataire simulé par défaut en développement', () => {
    const config = loadConfig(configSchema, BASE);
    expect(config.PAYMENT_PROVIDER).toBe('simulated');
    expect(createProvider(config).name).toBe('simulated');
  });

  it('FedaPay exige sa clé secrète et le secret du webhook', () => {
    expect(() => loadConfig(configSchema, { ...BASE, PAYMENT_PROVIDER: 'fedapay' })).toThrow(
      /FEDAPAY_SECRET_KEY/,
    );
    const config = loadConfig(configSchema, {
      ...BASE,
      PAYMENT_PROVIDER: 'fedapay',
      FEDAPAY_SECRET_KEY: 'sk_sandbox_x',
      FEDAPAY_WEBHOOK_SECRET: 'wh_x',
      FEDAPAY_XOF_CURRENCY_ID: '1',
    });
    expect(createProvider(config).name).toBe('fedapay');
  });

  it('FedaPay exige l’identifiant de la devise XOF : le service refuse de démarrer sans lui', () => {
    expect(() =>
      loadConfig(configSchema, {
        ...BASE,
        PAYMENT_PROVIDER: 'fedapay',
        FEDAPAY_SECRET_KEY: 'sk_sandbox_x',
        FEDAPAY_WEBHOOK_SECRET: 'wh_x',
      }),
    ).toThrow(/FEDAPAY_XOF_CURRENCY_ID/);
  });

  it('production : prestataire simulé interdit, jetons de service et retour HTTPS obligatoires', () => {
    const production = () =>
      loadConfig(configSchema, {
        ...BASE,
        NODE_ENV: 'production',
        IDENTITY_JWKS_URL: 'http://identity:3101/.well-known/jwks.json',
      });
    expect(production).toThrow(/PAYMENT_PROVIDER/);
    expect(production).toThrow(/SERVICE_CLIENT_SECRET/);
    expect(production).toThrow(/PAYMENT_RETURN_URL/);
    expect(production).toThrow(/PAYMENT_LINK_TOKEN_SECRET/);
    expect(production).toThrow(/PAYMENT_LINK_BASE_URL/);
  });

  it('production : FedaPay live seulement, clé sk_live_, adresse de l’API FedaPay en HTTPS (ADR-048)', () => {
    const production = (overrides: Record<string, string>) => () =>
      loadConfig(configSchema, {
        ...BASE,
        NODE_ENV: 'production',
        IDENTITY_JWKS_URL: 'https://identity/.well-known/jwks.json',
        IDENTITY_TOKEN_URL: 'https://identity/oauth/token',
        SERVICE_CLIENT_SECRET: 's'.repeat(32),
        PAYMENT_RETURN_URL: 'https://ksp.bj/mon-espace/paiements',
        PAYMENT_LINK_BASE_URL: 'https://ksp.bj/payer',
        PAYMENT_LINK_TOKEN_SECRET: 't'.repeat(40),
        PAYMENT_PROVIDER: 'fedapay',
        FEDAPAY_ENVIRONMENT: 'live',
        FEDAPAY_SECRET_KEY: 'sk_live_x',
        FEDAPAY_WEBHOOK_SECRET: 'wh_x',
        FEDAPAY_XOF_CURRENCY_ID: '1',
        ...overrides,
      });
    expect(production({})).not.toThrow();
    expect(production({ FEDAPAY_ENVIRONMENT: 'sandbox', FEDAPAY_SECRET_KEY: 'sk_sandbox_x' })).toThrow(
      /FEDAPAY_ENVIRONMENT/,
    );
    expect(production({ FEDAPAY_SECRET_KEY: 'sk_sandbox_x' })).toThrow(/FEDAPAY_SECRET_KEY/);
    expect(production({ FEDAPAY_API_URL: 'http://api.fedapay.com/v1' })).toThrow(/FEDAPAY_API_URL/);
    expect(production({ FEDAPAY_API_URL: 'https://fedapay.example.com/v1' })).toThrow(/FEDAPAY_API_URL/);
    expect(production({ FEDAPAY_API_URL: 'https://api.fedapay.com/v1' })).not.toThrow();
    // Reversements FedaPay en production : même clé, mêmes règles.
    expect(
      production({
        PAYOUT_PROVIDER: 'fedapay',
        FEDAPAY_ENVIRONMENT: 'sandbox',
        FEDAPAY_SECRET_KEY: 'sk_sandbox_x',
      }),
    ).toThrow(/FEDAPAY_ENVIRONMENT/);
  });

  it('clé et environnement FedaPay concordants, en tout environnement', () => {
    const fedapay = (env: string, key: string) => () =>
      loadConfig(configSchema, {
        ...BASE,
        PAYMENT_PROVIDER: 'fedapay',
        FEDAPAY_ENVIRONMENT: env,
        FEDAPAY_SECRET_KEY: key,
        FEDAPAY_WEBHOOK_SECRET: 'wh_x',
        FEDAPAY_XOF_CURRENCY_ID: '1',
      });
    expect(fedapay('sandbox', 'sk_live_x')).toThrow(/FEDAPAY_SECRET_KEY/);
    expect(fedapay('live', 'sk_sandbox_x')).toThrow(/FEDAPAY_SECRET_KEY/);
    expect(fedapay('sandbox', 'sk_sandbox_x')).not.toThrow();
  });

  it('liens et reversements : émetteurs autorisés, reversements manuels par défaut (ADR-040, ADR-041)', () => {
    const config = loadConfig(configSchema, { ...BASE, PAYMENT_LINK_ISSUERS: 'recovery, realestate' });
    expect(config.PAYMENT_LINK_ISSUERS).toEqual(['recovery', 'realestate']);
    expect(config.PAYMENT_PAYOUT_ISSUERS).toEqual(['wallet']);
    expect(createPayoutProvider(config).name).toBe('manual');
    expect(() => loadConfig(configSchema, { ...BASE, PAYOUT_PROVIDER: 'fedapay' })).toThrow(
      /FEDAPAY_SECRET_KEY/,
    );
    expect(() => loadConfig(configSchema, { ...BASE, PAYMENT_LINK_TOKEN_SECRET: 'court' })).toThrow(
      /PAYMENT_LINK_TOKEN_SECRET/,
    );
  });
});
