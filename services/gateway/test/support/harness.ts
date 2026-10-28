import { type AddressInfo, createServer } from 'node:net';
import { identityV1 } from '@ksp/contracts';
import {
  AppError,
  currentContext,
  GrpcContextInterceptor,
  GrpcExceptionFilter,
  grpcServerOptions,
  loadConfig,
  type RequestContext,
  SERVICE_TOKEN_PROVIDER,
  ServiceTokenVerifier,
  type ServiceTokenProvider,
} from '@ksp/platform';
import { Controller, Inject, type INestMicroservice, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type MicroserviceOptions } from '@nestjs/microservices';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type KeyLike,
  SignJWT,
} from 'jose';
import { AppModule } from '../../src/app.module';
import { type PublicSigningKey } from '../../src/application/keys/public-keys';
import { configSchema } from '../../src/config';
import { type JwksSource } from '../../src/infrastructure/keys/signing-keys-cache';
import { configureHttpApp } from '../../src/interfaces/http/http-app';
import { JWKS_SOURCE } from '../../src/tokens';

/**
 * Harnais de bout en bout : la vraie gateway (module, chaîne HTTP, client gRPC) face à un serveur
 * gRPC identity simulé, qui implémente le contrôleur généré depuis identity.proto et vérifie le
 * jeton de service de la gateway avec le kit, comme le vrai service.
 */

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export const USER_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e11';
export const SESSION_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e10';

export const protoUser: identityV1.User = {
  id: USER_ID,
  status: identityV1.UserStatus.USER_STATUS_ACTIVE,
  firstName: '',
  lastName: '',
  phoneE164: '+2290197000045',
  email: '',
  preferredLanguage: 'fr',
  createdAt: '2026-10-17T10:00:00.000Z',
  emailVerified: false,
};

/** Contexte personnel (particulier) : celui de toute session à son ouverture. */
export const protoIndividual: identityV1.ActiveContext = {
  type: identityV1.ContextType.CONTEXT_TYPE_INDIVIDUAL,
  organizationId: '',
  organizationName: '',
};

export const ORGANIZATION_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0a01';

/** Organisation validée, telle qu'identity la renvoie. */
export const protoOrganization: identityV1.Organization = {
  id: ORGANIZATION_ID,
  legalName: 'SARL Bénin Propre',
  address: 'Lot 1234, Haie Vive, Cotonou',
  ifu: '3201912345678',
  rccm: '',
  billingEmail: 'compta@beninpropre.bj',
  status: identityV1.OrganizationStatus.ORGANIZATION_STATUS_ACTIVE,
  createdBy: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e11',
  createdAt: '2026-10-27T10:00:00.000Z',
  reviewedBy: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8dad01',
  reviewedAt: '2026-10-27T11:00:00.000Z',
  rejectionReason: '',
  suspendedAt: '',
  suspensionReason: '',
};

const protoMembership: identityV1.OrganizationMembership = {
  organization: protoOrganization,
  role: identityV1.OrgRole.ORG_ROLE_ADMIN,
  pendingBillingEmail: '',
};

export function protoSession(refreshToken = 'rt-new'): identityV1.SessionTokens {
  return {
    accessToken: 'eyJhbGciOiJFUzI1NiJ9.e30.c2ln',
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    refreshToken,
    refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    sessionId: SESSION_ID,
    user: protoUser,
    profileIncomplete: true,
    activeContext: protoIndividual,
  };
}

type AuthMethod = keyof identityV1.AuthServiceController;
type AccountMethod = keyof identityV1.AccountServiceController;
type OrganizationMethod = keyof identityV1.OrganizationServiceController;
type OrganizationAdminMethod = keyof identityV1.OrganizationAdminServiceController;
type AccountAdminMethod = keyof identityV1.AccountAdminServiceController;
export type StubMethod =
  AuthMethod | AccountMethod | OrganizationMethod | OrganizationAdminMethod | AccountAdminMethod;

export interface RecordedCall {
  method: StubMethod;
  request: Record<string, unknown>;
  context: RequestContext | undefined;
}

/** Comportement du service simulé : réponses par défaut, remplaçables méthode par méthode. */
export class IdentityStub {
  readonly calls: RecordedCall[] = [];
  private readonly overrides = new Map<StubMethod, (request: Record<string, unknown>) => Promise<unknown>>();

  readonly defaults: Record<StubMethod, (request: Record<string, unknown>) => unknown> = {
    requestOtp: () => ({
      challengeId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e0f',
      maskedTarget: '+229********45',
      channel: identityV1.OtpChannel.OTP_CHANNEL_WHATSAPP,
      expiresInSeconds: 300,
      resendAfterSeconds: 60,
    }),
    verifyOtp: () => ({ result: { session: protoSession() }, isNewUser: true }),
    refreshSession: () => ({ session: protoSession('rt-rotated') }),
    logout: (request) => ({
      revokedSessions: request['scope'] === identityV1.LogoutScope.LOGOUT_SCOPE_ALL_DEVICES ? 3 : 1,
    }),
    getSigningKeys: () => ({ keys: [] }),
    enrollTotp: () => ({
      secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
      otpauthUri:
        'otpauth://totp/KSP:%2B2290197000045?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=KSP&algorithm=SHA1&digits=6&period=30',
      issuer: 'KSP',
      accountName: '+2290197000045',
      digits: 6,
      periodSeconds: 30,
    }),
    confirmTotp: () => ({
      session: protoSession('rt-admin'),
      recoveryCodes: Array.from({ length: 10 }, (_, index) => `7KQ2M-X9PD${index}`),
    }),
    verifyMfa: () => ({ session: protoSession('rt-admin'), recoveryCodesRemaining: 9 }),
    getMe: () => ({
      user: protoUser,
      profileIncomplete: true,
      pendingEmail: '',
      activeContext: protoIndividual,
    }),
    updateMe: (request) => ({
      user: { ...protoUser, ...request },
      profileIncomplete: !request['firstName'],
      pendingEmail: '',
      activeContext: protoIndividual,
    }),
    changeEmail: (request) => ({
      pendingEmail: String(request['email']).trim().toLowerCase(),
      expiresInSeconds: 900,
      resendAfterSeconds: 60,
    }),
    confirmEmail: () => ({
      user: { ...protoUser, email: 'koffi@exemple.com', emailVerified: true },
      profileIncomplete: true,
      activeContext: protoIndividual,
    }),
    switchContext: (request) => ({
      accessToken: 'eyJhbGciOiJFUzI1NiJ9.e30.b3Jn',
      accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
      activeContext: request['organizationId']
        ? {
            type: identityV1.ContextType.CONTEXT_TYPE_BUSINESS,
            organizationId: String(request['organizationId']),
            organizationName: 'SARL Bénin Propre',
          }
        : protoIndividual,
    }),
    createOrganization: () => ({
      membership: {
        ...protoMembership,
        organization: {
          ...protoOrganization,
          billingEmail: '',
          status: identityV1.OrganizationStatus.ORGANIZATION_STATUS_PENDING_REVIEW,
          reviewedBy: '',
          reviewedAt: '',
        },
      },
    }),
    listMyOrganizations: () => ({ memberships: [protoMembership] }),
    getMyOrganization: () => ({ membership: protoMembership }),
    changeOrganizationBillingEmail: (request) => ({
      pendingEmail: String(request['email']).trim().toLowerCase(),
      expiresInSeconds: 900,
      resendAfterSeconds: 60,
    }),
    confirmOrganizationBillingEmail: () => ({ membership: protoMembership }),
    listOrganizations: () => ({ organizations: [protoOrganization], nextCursor: ORGANIZATION_ID }),
    findAccountByPhone: () => ({
      account: {
        userId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0002',
        status: identityV1.UserStatus.USER_STATUS_ACTIVE,
        firstName: 'Awa',
        lastName: '',
        phoneMasked: '+229********45',
      },
    }),
    getOrganization: () => ({
      organization: protoOrganization,
      members: [
        {
          userId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e11',
          role: identityV1.OrgRole.ORG_ROLE_ADMIN,
          firstName: 'Koffi',
          lastName: '',
          phoneE164: '+2290197000045',
          joinedAt: '2026-10-27T10:00:00.000Z',
        },
      ],
    }),
    validateOrganization: () => ({ organization: protoOrganization }),
    rejectOrganization: (request) => ({
      organization: {
        ...protoOrganization,
        status: identityV1.OrganizationStatus.ORGANIZATION_STATUS_REJECTED,
        billingEmail: '',
        rejectionReason: String(request['reason']),
      },
    }),
    suspendOrganization: (request) => ({
      organization: {
        ...protoOrganization,
        status: identityV1.OrganizationStatus.ORGANIZATION_STATUS_SUSPENDED,
        suspendedAt: '2026-10-28T09:00:00.000Z',
        suspensionReason: String(request['reason']),
      },
    }),
    reactivateOrganization: () => ({ organization: protoOrganization }),
  };

  /** Remplace la réponse d'une méthode (erreur métier, délai…) jusqu'à reset(). */
  on(method: StubMethod, handler: (request: Record<string, unknown>) => Promise<unknown>): void {
    this.overrides.set(method, handler);
  }

  reset(): void {
    this.overrides.clear();
    this.calls.length = 0;
  }

  last(method: StubMethod): RecordedCall | undefined {
    return this.calls.filter((call) => call.method === method).at(-1);
  }

  async handle(method: StubMethod, request: Record<string, unknown>): Promise<never> {
    this.calls.push({ method, request, context: currentContext() });
    const override = this.overrides.get(method);
    return (override ? await override(request) : this.defaults[method](request)) as never;
  }
}

const STUB = Symbol('IDENTITY_STUB');

@Controller()
@identityV1.AuthServiceControllerMethods()
class StubAuthController implements identityV1.AuthServiceController {
  constructor(@Inject(STUB) private readonly stub: IdentityStub) {}
  requestOtp(request: identityV1.RequestOtpRequest) {
    return this.stub.handle('requestOtp', { ...request });
  }
  verifyOtp(request: identityV1.VerifyOtpRequest) {
    return this.stub.handle('verifyOtp', { ...request });
  }
  refreshSession(request: identityV1.RefreshSessionRequest) {
    return this.stub.handle('refreshSession', { ...request });
  }
  logout(request: identityV1.LogoutRequest) {
    return this.stub.handle('logout', { ...request });
  }
  getSigningKeys(request: identityV1.GetSigningKeysRequest) {
    return this.stub.handle('getSigningKeys', { ...request });
  }
  enrollTotp(request: identityV1.EnrollTotpRequest) {
    return this.stub.handle('enrollTotp', { ...request });
  }
  confirmTotp(request: identityV1.ConfirmTotpRequest) {
    return this.stub.handle('confirmTotp', { ...request });
  }
  verifyMfa(request: identityV1.VerifyMfaRequest) {
    return this.stub.handle('verifyMfa', { ...request });
  }
  switchContext(request: identityV1.SwitchContextRequest) {
    return this.stub.handle('switchContext', { ...request });
  }
}

@Controller()
@identityV1.OrganizationServiceControllerMethods()
class StubOrganizationController implements identityV1.OrganizationServiceController {
  constructor(@Inject(STUB) private readonly stub: IdentityStub) {}
  createOrganization(request: identityV1.CreateOrganizationRequest) {
    return this.stub.handle('createOrganization', { ...request });
  }
  listMyOrganizations(request: identityV1.ListMyOrganizationsRequest) {
    return this.stub.handle('listMyOrganizations', { ...request });
  }
  getMyOrganization(request: identityV1.GetMyOrganizationRequest) {
    return this.stub.handle('getMyOrganization', { ...request });
  }
  changeOrganizationBillingEmail(request: identityV1.ChangeOrganizationBillingEmailRequest) {
    return this.stub.handle('changeOrganizationBillingEmail', { ...request });
  }
  confirmOrganizationBillingEmail(request: identityV1.ConfirmOrganizationBillingEmailRequest) {
    return this.stub.handle('confirmOrganizationBillingEmail', { ...request });
  }
}

@Controller()
@identityV1.OrganizationAdminServiceControllerMethods()
class StubOrganizationAdminController implements identityV1.OrganizationAdminServiceController {
  constructor(@Inject(STUB) private readonly stub: IdentityStub) {}
  listOrganizations(request: identityV1.ListOrganizationsRequest) {
    return this.stub.handle('listOrganizations', { ...request });
  }
  getOrganization(request: identityV1.GetOrganizationRequest) {
    return this.stub.handle('getOrganization', { ...request });
  }
  validateOrganization(request: identityV1.ValidateOrganizationRequest) {
    return this.stub.handle('validateOrganization', { ...request });
  }
  rejectOrganization(request: identityV1.RejectOrganizationRequest) {
    return this.stub.handle('rejectOrganization', { ...request });
  }
  suspendOrganization(request: identityV1.SuspendOrganizationRequest) {
    return this.stub.handle('suspendOrganization', { ...request });
  }
  reactivateOrganization(request: identityV1.ReactivateOrganizationRequest) {
    return this.stub.handle('reactivateOrganization', { ...request });
  }
}

@Controller()
@identityV1.AccountAdminServiceControllerMethods()
class StubAccountAdminController implements identityV1.AccountAdminServiceController {
  constructor(@Inject(STUB) private readonly stub: IdentityStub) {}
  findAccountByPhone(request: identityV1.FindAccountByPhoneRequest) {
    return this.stub.handle('findAccountByPhone', { ...request });
  }
}

@Controller()
@identityV1.AccountServiceControllerMethods()
class StubAccountController implements identityV1.AccountServiceController {
  constructor(@Inject(STUB) private readonly stub: IdentityStub) {}
  getMe(request: identityV1.GetMeRequest) {
    return this.stub.handle('getMe', { ...request });
  }
  updateMe(request: identityV1.UpdateMeRequest) {
    return this.stub.handle('updateMe', { ...request });
  }
  changeEmail(request: identityV1.ChangeEmailRequest) {
    return this.stub.handle('changeEmail', { ...request });
  }
  confirmEmail(request: identityV1.ConfirmEmailRequest) {
    return this.stub.handle('confirmEmail', { ...request });
  }
}

/** Clés de test : jetons d'accès (publiés par la source JWKS) et jetons de service. */
export class TestKeys {
  private constructor(
    readonly accessKey: KeyLike,
    readonly accessJwk: PublicSigningKey,
    private readonly serviceKey: KeyLike,
    readonly serviceJwks: JSONWebKeySet,
  ) {}

  static async create(): Promise<TestKeys> {
    const access = await generateKeyPair('ES256');
    const service = await generateKeyPair('ES256');
    const a = await exportJWK(access.publicKey);
    const s = await exportJWK(service.publicKey);
    return new TestKeys(
      access.privateKey,
      { kid: 'k-test', kty: 'EC', crv: 'P-256', x: a.x!, y: a.y!, alg: 'ES256', use: 'sig' },
      service.privateKey,
      { keys: [{ ...s, kid: 'svc', alg: 'ES256', use: 'sig' }] },
    );
  }

  /** Source JWKS de la gateway : les clés publiques des jetons d'accès. */
  jwksSource(): JwksSource & { calls: number } {
    const source = {
      calls: 0,
      fetch: async () => {
        source.calls += 1;
        return [this.accessJwk];
      },
    };
    return source;
  }

  /** Jetons de service signés sur place, au nom de la gateway (ADR-022). */
  serviceTokens(): ServiceTokenProvider {
    return {
      getToken: (audience: string) =>
        new SignJWT({ token_use: 'service' })
          .setProtectedHeader({ alg: 'ES256', kid: 'svc' })
          .setIssuer('ksp-identity')
          .setSubject('gateway')
          .setAudience(audience)
          .setJti('0192f1c4-0000-7000-8000-000000000001')
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(this.serviceKey),
    };
  }

  /** Jeton d'accès conforme au contrat (contracts/tokens/access-token.v1.schema.json). */
  accessToken(
    options: {
      expiresIn?: string | number;
      key?: KeyLike;
      kid?: string;
      claims?: Record<string, unknown>;
      /** Autre utilisateur que USER_ID (compteurs de limites par utilisateur distincts). */
      subject?: string;
    } = {},
  ): Promise<string> {
    return new SignJWT({
      client_id: 'web',
      jti: '0192f1c4-0000-7000-8000-000000000002',
      token_use: 'access',
      sid: SESSION_ID,
      ctx: 'personal',
      roles: [{ role: 'customer', scopeType: 'personal' }],
      mfa: false,
      auth_time: Math.floor(Date.now() / 1000),
      ...options.claims,
    })
      .setProtectedHeader({ alg: 'ES256', kid: options.kid ?? 'k-test', typ: 'at+jwt' })
      .setIssuer('ksp-identity')
      .setAudience('ksp-api')
      .setSubject(options.subject ?? USER_ID)
      .setIssuedAt()
      .setExpirationTime(options.expiresIn ?? '15m')
      .sign(options.key ?? this.accessKey);
  }
}

export interface IdentityServer {
  stub: IdentityStub;
  url: string;
  close(): Promise<void>;
}

export async function startIdentityStub(keys: TestKeys): Promise<IdentityServer> {
  const stub = new IdentityStub();

  @Module({
    controllers: [
      StubAuthController,
      StubAccountController,
      StubOrganizationController,
      StubOrganizationAdminController,
      StubAccountAdminController,
    ],
    providers: [{ provide: STUB, useValue: stub }],
  })
  class StubModule {}

  const port = await freePort();
  const app: INestMicroservice = await NestFactory.createMicroservice<MicroserviceOptions>(StubModule, {
    ...grpcServerOptions(['identity'], port),
    logger: false,
  });
  app.useGlobalFilters(new GrpcExceptionFilter());
  app.useGlobalInterceptors(
    new GrpcContextInterceptor(
      new ServiceTokenVerifier({
        audience: 'identity',
        issuer: 'ksp-identity',
        keys: createLocalJWKSet(keys.serviceJwks),
      }),
    ),
  );
  await app.listen();
  return { stub, url: `127.0.0.1:${port}`, close: () => app.close() };
}

export const ORIGINS = {
  web: 'https://ksp.bj',
  backoffice: 'https://admin.ksp.bj',
};

/** La gateway complète, avec la même chaîne HTTP qu'en production. */
export async function startGateway(options: {
  identityUrl: string;
  /** Service cleaning simulé (cleaning-stub.ts) ; sans lui, les routes du Nettoyage répondent 503. */
  cleaningUrl?: string;
  /** Service billing simulé (billing-stub.ts) ; sans lui, les routes de facturation répondent 503. */
  billingUrl?: string;
  keys: TestKeys;
  env?: Record<string, string>;
  jwks?: JwksSource;
}): Promise<NestExpressApplication> {
  const config = loadConfig(configSchema, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    IDENTITY_GRPC_URL: options.identityUrl,
    ...(options.cleaningUrl ? { CLEANING_GRPC_URL: options.cleaningUrl } : {}),
    ...(options.billingUrl ? { BILLING_GRPC_URL: options.billingUrl } : {}),
    CORS_WEB_ORIGINS: `${ORIGINS.web},https://shop.ksp.bj,https://print.ksp.bj`,
    CORS_BACKOFFICE_ORIGINS: ORIGINS.backoffice,
    ...options.env,
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
    .overrideProvider(JWKS_SOURCE)
    .useValue(options.jwks ?? options.keys.jwksSource())
    .overrideProvider(SERVICE_TOKEN_PROVIDER)
    .useValue(options.keys.serviceTokens())
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  configureHttpApp(app, config);
  await app.init();
  return app;
}

/** Erreur métier telle qu'identity la lève. */
export function identityError(error: AppError): () => Promise<never> {
  return () => Promise.reject(error);
}
