import { loadConfig } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { CLEANING_DEPS, type CleaningDeps } from '../src/application/deps';
import { configSchema } from '../src/config';
import { IdentityAgentAccounts } from '../src/infrastructure/identity/identity-agent-accounts';
import { IdentityAgentRoles } from '../src/infrastructure/identity/identity-agent-roles';
import { IdentityPermissionCatalog } from '../src/infrastructure/identity/identity-permission-catalog';
import {
  CATALOG_REGISTRATION_RETRY_MS,
  PERMISSION_CATALOG_REGISTRY,
  PermissionCatalogRegistrationService,
} from '../src/infrastructure/identity/permission-catalog-registration.service';

const ENV = {
  SERVICE_NAME: 'cleaning',
  NODE_ENV: 'test',
  GRPC_PORT: '50053',
  HTTP_PORT: '3103',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  RABBITMQ_URL: 'amqp://localhost',
};

/** Câblage de la piste A (agents) dans le module du service. */
describe('AppModule, piste A (agents)', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(loadConfig(configSchema, ENV))],
    }).compile();
  });

  afterAll(async () => {
    await moduleRef?.close();
    jest.restoreAllMocks();
  });

  it('catalogue des permissions : déclaré à identity au démarrage, premier nouvel essai après 5 s', () => {
    expect(moduleRef.get(PermissionCatalogRegistrationService)).toBeDefined();
    expect(moduleRef.get(PERMISSION_CATALOG_REGISTRY)).toBeInstanceOf(IdentityPermissionCatalog);
    expect(moduleRef.get(CATALOG_REGISTRATION_RETRY_MS)).toBe(5_000);
  });

  it('rôle cleaning_agent et compte d’un agent créé par l’admin : chez identity', () => {
    const deps = moduleRef.get<CleaningDeps>(CLEANING_DEPS);
    expect(deps.roles).toBeInstanceOf(IdentityAgentRoles);
    expect(deps.accounts).toBeInstanceOf(IdentityAgentAccounts);
  });
});

describe('configuration, piste A (agents)', () => {
  it('déclaration du catalogue : désactivée avec 0, jamais plus de 10 minutes d’attente initiale', () => {
    expect(loadConfig(configSchema, { ...ENV, CLEANING_CATALOG_REGISTRATION_RETRY_MS: '0' })).toMatchObject({
      CLEANING_CATALOG_REGISTRATION_RETRY_MS: 0,
    });
    expect(() =>
      loadConfig(configSchema, { ...ENV, CLEANING_CATALOG_REGISTRATION_RETRY_MS: '600001' }),
    ).toThrow('CLEANING_CATALOG_REGISTRATION_RETRY_MS');
  });
});
