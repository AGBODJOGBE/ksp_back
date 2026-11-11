import { allowedCallersOf, loadConfig } from '@ksp/platform';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { configSchema } from '../src/config';
import {
  ObligationGrpcController,
  WalletAccountGrpcController,
  WalletAdminGrpcController,
  WalletGrpcController,
} from '../src/interfaces/grpc/wallet.controllers';

describe('appelants des contrôleurs gRPC (ADR-048)', () => {
  it('espace du titulaire et back-office : gateway seulement ; méthodes internes vérifiées par le cas d’usage', () => {
    expect(allowedCallersOf(WalletAccountGrpcController)).toEqual(['gateway']);
    expect(allowedCallersOf(WalletAdminGrpcController)).toEqual(['gateway']);
    expect(allowedCallersOf(WalletGrpcController)).toBeUndefined();
    expect(allowedCallersOf(ObligationGrpcController)).toBeUndefined();
  });
});

const BASE = {
  SERVICE_NAME: 'wallet',
  NODE_ENV: 'test',
  GRPC_PORT: '50057',
  HTTP_PORT: '3107',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  RABBITMQ_URL: 'amqp://localhost',
};

describe('AppModule', () => {
  it('assemble toutes les dépendances du service', async () => {
    const config = loadConfig(configSchema, { ...BASE, WALLET_PAYOUT_SUBMIT_INTERVAL_MS: '0' });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] }).compile();
    expect(moduleRef.get(WalletGrpcController)).toBeDefined();
    expect(moduleRef.get(WalletAccountGrpcController)).toBeDefined();
    expect(moduleRef.get(WalletAdminGrpcController)).toBeDefined();
    await moduleRef.close();
  });
});

describe('configuration de wallet', () => {
  it('appelants du grand livre : recovery par défaut, liste séparée par des virgules', () => {
    expect(loadConfig(configSchema, BASE).WALLET_LEDGER_CALLERS).toEqual(['recovery']);
    expect(
      loadConfig(configSchema, { ...BASE, WALLET_LEDGER_CALLERS: 'recovery, realestate' })
        .WALLET_LEDGER_CALLERS,
    ).toEqual(['recovery', 'realestate']);
  });

  it('production : jeton de service obligatoire (reversements transmis à payment)', () => {
    expect(() =>
      loadConfig(configSchema, {
        ...BASE,
        NODE_ENV: 'production',
        IDENTITY_JWKS_URL: 'http://identity:3101/.well-known/jwks.json',
      }),
    ).toThrow(/SERVICE_CLIENT_SECRET/);
  });

  it('production : clé propre de l’empreinte des numéros (ADR-048)', () => {
    const production = (secret?: string) => () =>
      loadConfig(configSchema, {
        ...BASE,
        NODE_ENV: 'production',
        IDENTITY_JWKS_URL: 'https://identity/.well-known/jwks.json',
        IDENTITY_TOKEN_URL: 'https://identity/oauth/token',
        SERVICE_CLIENT_SECRET: 's'.repeat(32),
        PAYMENT_GRPC_URL: 'dns:///payment-headless:50055',
        ...(secret ? { WALLET_PHONE_HASH_SECRET: secret } : {}),
      });
    expect(production()).toThrow(/WALLET_PHONE_HASH_SECRET/);
    expect(production('p'.repeat(40))).not.toThrow();
  });
});
