import { loadConfig } from '@ksp/platform';
import { Test } from '@nestjs/testing';
import { AppModule, createProvider } from '../src/app.module';
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
  });
});
