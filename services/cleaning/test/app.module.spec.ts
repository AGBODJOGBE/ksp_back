import { loadConfig } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { CLEANING_DEPS, type CleaningDeps } from '../src/application/deps';
import { configSchema } from '../src/config';
import { GrpcPhotoStore } from '../src/infrastructure/file/grpc-photo-store';
import { GeoServiceGeocoder } from '../src/infrastructure/geocoding/geo-service.geocoder';
import { IdentityPeopleDirectory } from '../src/infrastructure/identity/identity-people-directory';
import { OutboxRelayService } from '../src/infrastructure/messaging/outbox-relay.service';
import { SystemClock, UuidV7Generator } from '../src/infrastructure/system/system';
import { GrpcWalletLedger } from '../src/infrastructure/wallet/grpc-wallet-ledger';
import { CLEANING_GRPC_CONTROLLERS } from '../src/interfaces/grpc/controllers';

const ENV = {
  SERVICE_NAME: 'cleaning',
  NODE_ENV: 'test',
  GRPC_PORT: '50053',
  HTTP_PORT: '3103',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  RABBITMQ_URL: 'amqp://localhost',
};

describe('AppModule', () => {
  afterEach(() => jest.restoreAllMocks());

  it('assemble le squelette v2 : contrôleurs, outbox et adaptateurs vers les autres services', async () => {
    const warnings: string[] = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
    const config = loadConfig(configSchema, ENV);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] }).compile();
    for (const controller of CLEANING_GRPC_CONTROLLERS) expect(moduleRef.get(controller)).toBeDefined();
    expect(moduleRef.get(OutboxRelayService)).toBeDefined();
    const deps = moduleRef.get<CleaningDeps>(CLEANING_DEPS);
    expect(deps.people).toBeInstanceOf(IdentityPeopleDirectory);
    expect(deps.wallet).toBeInstanceOf(GrpcWalletLedger);
    expect(deps.photos).toBeInstanceOf(GrpcPhotoStore);
    expect(deps.geocoder).toBeInstanceOf(GeoServiceGeocoder);
    expect(deps.clock).toBeInstanceOf(SystemClock);
    expect(deps.ids).toBeInstanceOf(UuidV7Generator);
    expect(deps.ids.next()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(warnings).toContain(
      'Aucun jeton de service : appels vers identity, wallet, file et geo non authentifiés (développement uniquement).',
    );
    await moduleRef.close();
  });
});

describe('configuration', () => {
  it('adresses gRPC locales par défaut en développement, geo compris (plus de repli direct, ADR-059)', () => {
    expect(loadConfig(configSchema, ENV)).toMatchObject({
      IDENTITY_GRPC_URL: 'localhost:50051',
      FILE_GRPC_URL: 'localhost:50056',
      WALLET_GRPC_URL: 'localhost:50057',
      GEO_GRPC_URL: 'localhost:50059',
      GEOCODING_TIMEOUT_MS: 3_000,
    });
  });

  it('production : jeton de service obligatoire et jamais localhost (ADR-022, ADR-051)', () => {
    const production = {
      ...ENV,
      NODE_ENV: 'production',
      IDENTITY_JWKS_URL: 'http://identity:3101/.well-known/jwks.json',
      IDENTITY_GRPC_URL: 'dns:///identity-headless:50051',
      FILE_GRPC_URL: 'dns:///file-headless:50056',
      WALLET_GRPC_URL: 'dns:///wallet-headless:50057',
      GEO_GRPC_URL: 'dns:///geo-headless:50059',
    };
    expect(() => loadConfig(configSchema, production)).toThrow('SERVICE_CLIENT_SECRET');
    const withToken = {
      ...production,
      IDENTITY_TOKEN_URL: 'http://identity:3101/internal/token',
      SERVICE_CLIENT_SECRET: 'secret',
    };
    expect(loadConfig(configSchema, withToken).GEO_GRPC_URL).toBe('dns:///geo-headless:50059');
    expect(() => loadConfig(configSchema, { ...withToken, GEO_GRPC_URL: 'localhost:50059' })).toThrow(
      'GEO_GRPC_URL',
    );
  });
});
