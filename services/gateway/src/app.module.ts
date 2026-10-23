import { identityV1 } from '@ksp/contracts';
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
import { AuthorizeRequestUseCase } from './application/access/authorize-request.use-case';
import {
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
import { IdentityGrpcAdapter } from './infrastructure/grpc/identity-grpc.adapter';
import { HttpJwksSource } from './infrastructure/keys/http-jwks.source';
import { KeysReadiness } from './infrastructure/keys/keys-readiness';
import { type JwksSource, SigningKeysCache } from './infrastructure/keys/signing-keys-cache';
import { InMemoryRateLimiter } from './infrastructure/rate-limit/in-memory-rate-limiter';
import { SystemClock } from './infrastructure/system/system-clock';
import { IdentityHttpController } from './interfaces/http/identity.controller';
import { JwksHttpController } from './interfaces/http/jwks.controller';
import { RefreshCookies } from './interfaces/http/refresh-cookie';
import { RouteGuard } from './interfaces/http/route.guard';
import { CLOCK, IDENTITY_GRPC_CLIENT, JWKS_SOURCE, RATE_LIMITER } from './tokens';

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
        ]),
      ],
      controllers: [HealthController, IdentityHttpController, JwksHttpController],
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
        {
          provide: GetPublicKeysUseCase,
          inject: [SigningKeysCache],
          useFactory: (keys: SigningKeysCache) => new GetPublicKeysUseCase(keys),
        },
      ],
    };
  }
}
