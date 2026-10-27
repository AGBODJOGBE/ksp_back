import { billingV1, cleaningV1, identityV1 } from '@ksp/contracts';
import {
  AccessTokenVerifier,
  createLoggerModule,
  GrpcCaller,
  grpcClientOptions,
  HealthController,
  ReadinessRegistry,
  SERVICE_TOKEN_PROVIDER,
  ServiceTokenClient,
  type ServiceTokenProvider,
} from '@ksp/platform';
import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { type ClientGrpc, ClientsModule } from '@nestjs/microservices';
import { type Clock, type RateLimiter } from './application/access/access.ports';
import { type BillingApi } from './application/billing/billing.ports';
import { type CleaningApi } from './application/cleaning/cleaning.ports';
import { RequestCleaningQuoteUseCase } from './application/cleaning/request-cleaning-quote.use-case';
import { AuthorizeRequestUseCase } from './application/access/authorize-request.use-case';
import {
  ChangeEmailUseCase,
  ConfirmEmailUseCase,
  ConfirmTotpUseCase,
  EnrollTotpUseCase,
  GetMeUseCase,
  LogoutUseCase,
  RefreshSessionUseCase,
  RequestOtpUseCase,
  UpdateMeUseCase,
  VerifyMfaUseCase,
  VerifyOtpUseCase,
} from './application/identity/identity.use-cases';
import { GetPublicKeysUseCase } from './application/keys/public-keys';
import { clientOriginsFrom, DEV_IDENTITY_JWKS_URL, type GatewayConfig, rateLimitsFrom } from './config';
import { BillingGrpcAdapter } from './infrastructure/grpc/billing-grpc.adapter';
import { CleaningGrpcAdapter } from './infrastructure/grpc/cleaning-grpc.adapter';
import { IdentityGrpcAdapter } from './infrastructure/grpc/identity-grpc.adapter';
import { HttpJwksSource } from './infrastructure/keys/http-jwks.source';
import { KeysReadiness } from './infrastructure/keys/keys-readiness';
import { type JwksSource, SigningKeysCache } from './infrastructure/keys/signing-keys-cache';
import { InMemoryRateLimiter } from './infrastructure/rate-limit/in-memory-rate-limiter';
import { SystemClock } from './infrastructure/system/system-clock';
import { BillingHttpController } from './interfaces/http/billing.controller';
import { CleaningAdminHttpController } from './interfaces/http/cleaning-admin.controller';
import { CleaningHttpController } from './interfaces/http/cleaning.controller';
import { IdentityHttpController } from './interfaces/http/identity.controller';
import { JwksHttpController } from './interfaces/http/jwks.controller';
import { RefreshCookies } from './interfaces/http/refresh-cookie';
import { RouteGuard } from './interfaces/http/route.guard';
import {
  BILLING_API,
  BILLING_GRPC_CLIENT,
  CLEANING_API,
  CLEANING_GRPC_CLIENT,
  CLOCK,
  IDENTITY_GRPC_CLIENT,
  JWKS_SOURCE,
  RATE_LIMITER,
} from './tokens';

/** Racine de composition : relie chaque cas d'usage à ses adaptateurs. Aucune base, aucun serveur gRPC. */
@Module({})
export class AppModule {
  static forRoot(config: GatewayConfig): DynamicModule {
    const identityUseCase = <T>(UseCase: new (identity: IdentityGrpcAdapter) => T) => ({
      provide: UseCase,
      inject: [IdentityGrpcAdapter],
      useFactory: (identity: IdentityGrpcAdapter) => new UseCase(identity),
    });

    return {
      module: AppModule,
      imports: [
        createLoggerModule(config.SERVICE_NAME, config.LOG_LEVEL),
        ClientsModule.register([
          grpcClientOptions(IDENTITY_GRPC_CLIENT, 'identity', config.IDENTITY_GRPC_URL),
          grpcClientOptions(CLEANING_GRPC_CLIENT, 'cleaning', config.CLEANING_GRPC_URL),
          grpcClientOptions(BILLING_GRPC_CLIENT, 'billing', config.BILLING_GRPC_URL),
        ]),
      ],
      controllers: [
        HealthController,
        IdentityHttpController,
        JwksHttpController,
        CleaningHttpController,
        CleaningAdminHttpController,
        BillingHttpController,
      ],
      providers: [
        ReadinessRegistry,
        { provide: CLOCK, useValue: new SystemClock() },
        {
          provide: JWKS_SOURCE,
          useFactory: (): JwksSource =>
            new HttpJwksSource({ url: config.IDENTITY_JWKS_URL ?? DEV_IDENTITY_JWKS_URL }),
        },
        {
          provide: SigningKeysCache,
          inject: [JWKS_SOURCE, CLOCK],
          useFactory: (source: JwksSource, clock: Clock) =>
            new SigningKeysCache(
              source,
              {
                ttlSeconds: config.JWKS_CACHE_TTL_SECONDS,
                reloadCooldownSeconds: config.JWKS_RELOAD_COOLDOWN_SECONDS,
              },
              clock,
            ),
        },
        KeysReadiness,
        {
          // Jeton de service joint à chaque appel vers identity (ADR-022) ; obligatoire en production.
          provide: SERVICE_TOKEN_PROVIDER,
          useFactory: (): ServiceTokenProvider | null => {
            if (config.IDENTITY_TOKEN_URL && config.SERVICE_CLIENT_SECRET) {
              return new ServiceTokenClient({
                tokenUrl: config.IDENTITY_TOKEN_URL,
                clientId: config.SERVICE_NAME,
                clientSecret: config.SERVICE_CLIENT_SECRET,
              });
            }
            new Logger('AppModule').warn(
              'Aucun jeton de service : appels vers identity non authentifiés (développement uniquement).',
            );
            return null;
          },
        },
        {
          provide: IdentityGrpcAdapter,
          inject: [IDENTITY_GRPC_CLIENT, SERVICE_TOKEN_PROVIDER],
          useFactory: (grpc: ClientGrpc, serviceTokens: ServiceTokenProvider | null) =>
            new IdentityGrpcAdapter(
              grpc.getService<identityV1.AuthServiceClient>(identityV1.AUTH_SERVICE_NAME),
              grpc.getService<identityV1.AccountServiceClient>(identityV1.ACCOUNT_SERVICE_NAME),
              // Un appelant par service : son coupe-circuit n'affecte pas les routes des autres (UC-GW-07).
              new GrpcCaller({
                target: 'identity',
                defaultDeadlineMs: config.GRPC_DEADLINE_MS,
                ...(serviceTokens ? { serviceTokenProvider: serviceTokens } : {}),
              }),
            ),
        },
        {
          provide: CLEANING_API,
          inject: [CLEANING_GRPC_CLIENT, SERVICE_TOKEN_PROVIDER],
          useFactory: (grpc: ClientGrpc, serviceTokens: ServiceTokenProvider | null): CleaningApi =>
            new CleaningGrpcAdapter(
              {
                catalog: grpc.getService<cleaningV1.CatalogServiceClient>(cleaningV1.CATALOG_SERVICE_NAME),
                quotes: grpc.getService<cleaningV1.QuoteServiceClient>(cleaningV1.QUOTE_SERVICE_NAME),
                missions: grpc.getService<cleaningV1.MissionServiceClient>(cleaningV1.MISSION_SERVICE_NAME),
                admin: grpc.getService<cleaningV1.CleaningAdminServiceClient>(
                  cleaningV1.CLEANING_ADMIN_SERVICE_NAME,
                ),
              },
              // Coupe-circuit propre à cleaning : une panne n'affecte pas les autres routes (UC-GW-07).
              new GrpcCaller({
                target: 'cleaning',
                defaultDeadlineMs: config.GRPC_DEADLINE_MS,
                ...(serviceTokens ? { serviceTokenProvider: serviceTokens } : {}),
              }),
            ),
        },
        {
          provide: BILLING_API,
          inject: [BILLING_GRPC_CLIENT, SERVICE_TOKEN_PROVIDER],
          useFactory: (grpc: ClientGrpc, serviceTokens: ServiceTokenProvider | null): BillingApi =>
            new BillingGrpcAdapter(
              {
                invoices: grpc.getService<billingV1.BillingServiceClient>(billingV1.BILLING_SERVICE_NAME),
                admin: grpc.getService<billingV1.BillingAdminServiceClient>(
                  billingV1.BILLING_ADMIN_SERVICE_NAME,
                ),
              },
              // Coupe-circuit propre à billing : une panne n'affecte pas les autres routes (UC-GW-07).
              new GrpcCaller({
                target: 'billing',
                defaultDeadlineMs: config.GRPC_DEADLINE_MS,
                ...(serviceTokens ? { serviceTokenProvider: serviceTokens } : {}),
              }),
            ),
        },
        {
          provide: RequestCleaningQuoteUseCase,
          inject: [IdentityGrpcAdapter, CLEANING_API],
          useFactory: (identity: IdentityGrpcAdapter, cleaning: CleaningApi) =>
            new RequestCleaningQuoteUseCase(identity, cleaning),
        },
        {
          provide: RATE_LIMITER,
          inject: [CLOCK],
          useFactory: (clock: Clock): RateLimiter => new InMemoryRateLimiter(clock),
        },
        {
          provide: AuthorizeRequestUseCase,
          inject: [SigningKeysCache, RATE_LIMITER, CLOCK],
          useFactory: (keys: SigningKeysCache, limiter: RateLimiter, clock: Clock) =>
            new AuthorizeRequestUseCase(
              new AccessTokenVerifier({ keys: keys.resolveKey }),
              limiter,
              clientOriginsFrom(config),
              rateLimitsFrom(config),
              clock,
            ),
        },
        RouteGuard,
        { provide: RefreshCookies, useValue: new RefreshCookies(!config.REFRESH_COOKIE_INSECURE) },
        identityUseCase(RequestOtpUseCase),
        identityUseCase(VerifyOtpUseCase),
        identityUseCase(RefreshSessionUseCase),
        identityUseCase(LogoutUseCase),
        identityUseCase(GetMeUseCase),
        identityUseCase(UpdateMeUseCase),
        identityUseCase(EnrollTotpUseCase),
        identityUseCase(ConfirmTotpUseCase),
        identityUseCase(VerifyMfaUseCase),
        identityUseCase(ChangeEmailUseCase),
        identityUseCase(ConfirmEmailUseCase),
        {
          provide: GetPublicKeysUseCase,
          inject: [SigningKeysCache],
          useFactory: (keys: SigningKeysCache) => new GetPublicKeysUseCase(keys),
        },
      ],
    };
  }
}
