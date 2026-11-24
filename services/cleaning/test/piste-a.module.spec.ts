import { loadConfig } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { CLEANING_DEPS, type CleaningDeps } from '../src/application/deps';
import { configSchema } from '../src/config';
import { BlindIndexPhoneFingerprints } from '../src/infrastructure/crypto/phone-fingerprints';
import { IdentityAgentAccounts } from '../src/infrastructure/identity/identity-agent-accounts';
import { IdentityAgentRoles } from '../src/infrastructure/identity/identity-agent-roles';
import { IdentityPermissionCatalog } from '../src/infrastructure/identity/identity-permission-catalog';
import {
  CATALOG_REGISTRATION_RETRY_MS,
  PERMISSION_CATALOG_REGISTRY,
  PermissionCatalogRegistrationService,
} from '../src/infrastructure/identity/permission-catalog-registration.service';
import { NotificationInvitationSender } from '../src/infrastructure/notification/notification-invitation-sender';

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

  it('invitation d’un agent : envoyée par notification, numéro retrouvé par une empreinte à clé', () => {
    const deps = moduleRef.get<CleaningDeps>(CLEANING_DEPS);
    expect(deps.invitations).toBeInstanceOf(NotificationInvitationSender);
    expect(deps.phoneFingerprints).toBeInstanceOf(BlindIndexPhoneFingerprints);
    const fingerprint = deps.phoneFingerprints!.invitationPhone('+229 97 00 00 45');
    expect(fingerprint).toBe(deps.phoneFingerprints!.invitationPhone('+2290197000045'));
    expect(fingerprint).not.toContain('97000045');
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

  it('invitation : notification et application agent locales par défaut, clé de l’empreinte contrôlée', () => {
    expect(loadConfig(configSchema, ENV)).toMatchObject({
      NOTIFICATION_GRPC_URL: 'localhost:50052',
      CLEANING_AGENT_APP_URL: 'http://localhost:3020',
    });
    expect(() => loadConfig(configSchema, { ...ENV, CLEANING_AGENT_APP_URL: 'application agent' })).toThrow(
      'CLEANING_AGENT_APP_URL',
    );
    expect(() => loadConfig(configSchema, { ...ENV, CLEANING_BLIND_INDEX_KEYS: 'trop-court' })).toThrow(
      'CLEANING_BLIND_INDEX_KEYS',
    );
  });

  it('production : jamais une adresse locale pour notification ni pour l’application agent', () => {
    const production = {
      ...ENV,
      NODE_ENV: 'production',
      IDENTITY_JWKS_URL: 'http://identity:3101/.well-known/jwks.json',
      IDENTITY_TOKEN_URL: 'http://identity:3101/internal/token',
      SERVICE_CLIENT_SECRET: 'secret',
      IDENTITY_GRPC_URL: 'dns:///identity-headless:50051',
      FILE_GRPC_URL: 'dns:///file-headless:50056',
      WALLET_GRPC_URL: 'dns:///wallet-headless:50057',
      GEO_GRPC_URL: 'dns:///geo-headless:50059',
      BILLING_GRPC_URL: 'dns:///billing-headless:50054',
      PAYMENT_GRPC_URL: 'dns:///payment-headless:50055',
      NOTIFICATION_GRPC_URL: 'dns:///notification-headless:50052',
      CLEANING_AGENT_APP_URL: 'https://agent.ksp.test',
    };
    expect(loadConfig(configSchema, production).CLEANING_AGENT_APP_URL).toBe('https://agent.ksp.test');
    expect(() =>
      loadConfig(configSchema, { ...production, CLEANING_AGENT_APP_URL: 'http://localhost:3020' }),
    ).toThrow('CLEANING_AGENT_APP_URL');
    expect(() =>
      loadConfig(configSchema, { ...production, NOTIFICATION_GRPC_URL: 'localhost:50052' }),
    ).toThrow('NOTIFICATION_GRPC_URL');
  });
});
