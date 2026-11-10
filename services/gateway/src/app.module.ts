import {
  billingV1,
  cleaningV1,
  documentV1,
  fileV1,
  identityV1,
  notificationV1,
  paymentV1,
  walletV1,
} from '@ksp/contracts';
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
  ShutdownState,
} from '@ksp/platform';
import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { type ClientGrpc, ClientsModule } from '@nestjs/microservices';
import { type Clock, type RateLimiter } from './application/access/access.ports';
import { type BillingApi } from './application/billing/billing.ports';
import { type CleaningApi } from './application/cleaning/cleaning.ports';
import { type AccountAdminApi } from './application/identity/account-admin.ports';
import { type OrganizationsApi } from './application/identity/organizations.ports';
import { type NotificationApi } from './application/notification/notification.ports';
import { type DocumentApi } from './application/document/document.ports';
import { type FileApi } from './application/file/file.ports';
import { type PaymentApi } from './application/payment/payment.ports';
import { type WalletApi } from './application/wallet/wallet.ports';
import { RequestCleaningQuoteUseCase } from './application/cleaning/request-cleaning-quote.use-case';
import { AuthorizeRequestUseCase } from './application/access/authorize-request.use-case';
import {
  ChangeEmailUseCase,
  ConfirmEmailUseCase,
  ConfirmTotpUseCase,
  EnrollTotpUseCase,
  CancelAccountDeletionUseCase,
  GetMeUseCase,
  RequestAccountDeletionUseCase,
  LogoutUseCase,
  RefreshSessionUseCase,
  RequestOtpUseCase,
  UpdateMeUseCase,
  VerifyMfaUseCase,
  VerifyOtpUseCase,
} from './application/identity/identity.use-cases';
import { GetPublicKeysUseCase } from './application/keys/public-keys';
import {
  authenticatedIpLimitFrom,
  clientOriginsFrom,
  DEV_IDENTITY_JWKS_URL,
  type GatewayConfig,
  rateLimitsFrom,
} from './config';
import { AccountAdminGrpcAdapter } from './infrastructure/grpc/account-admin-grpc.adapter';
import { BillingGrpcAdapter } from './infrastructure/grpc/billing-grpc.adapter';
import { CleaningGrpcAdapter } from './infrastructure/grpc/cleaning-grpc.adapter';
import { IdentityGrpcAdapter } from './infrastructure/grpc/identity-grpc.adapter';
import { OrganizationsGrpcAdapter } from './infrastructure/grpc/organizations-grpc.adapter';
import { NotificationGrpcAdapter } from './infrastructure/grpc/notification-grpc.adapter';
import { DocumentGrpcAdapter } from './infrastructure/grpc/document-grpc.adapter';
import { FileGrpcAdapter } from './infrastructure/grpc/file-grpc.adapter';
import { PaymentGrpcAdapter } from './infrastructure/grpc/payment-grpc.adapter';
import { WalletGrpcAdapter } from './infrastructure/grpc/wallet-grpc.adapter';
import { HttpJwksSource } from './infrastructure/keys/http-jwks.source';
import { KeysReadiness } from './infrastructure/keys/keys-readiness';
import { type JwksSource, SigningKeysCache } from './infrastructure/keys/signing-keys-cache';
import { InMemoryRateLimiter } from './infrastructure/rate-limit/in-memory-rate-limiter';
import { SystemClock } from './infrastructure/system/system-clock';
import { AccountAdminHttpController } from './interfaces/http/account-admin.controller';
import { BillingHttpController } from './interfaces/http/billing.controller';
import { CleaningAdminHttpController } from './interfaces/http/cleaning-admin.controller';
import { CleaningHttpController } from './interfaces/http/cleaning.controller';
import { IdentityHttpController } from './interfaces/http/identity.controller';
import { JwksHttpController } from './interfaces/http/jwks.controller';
import { OrganizationAdminHttpController } from './interfaces/http/organizations-admin.controller';
import { OrganizationHttpController } from './interfaces/http/organizations.controller';
import { NotificationHttpController } from './interfaces/http/notification.controller';
import { DocumentHttpController } from './interfaces/http/document.controller';
import { FileHttpController } from './interfaces/http/file.controller';
import { PaymentHttpController } from './interfaces/http/payment.controller';
import { WalletHttpController } from './interfaces/http/wallet.controller';
import { RefreshCookies } from './interfaces/http/refresh-cookie';
import { RouteGuard } from './interfaces/http/route.guard';
import {
  ACCOUNT_ADMIN_API,
  BILLING_API,
  BILLING_GRPC_CLIENT,
  CLEANING_API,
  CLEANING_GRPC_CLIENT,
  CLOCK,
  DOCUMENT_API,
  DOCUMENT_GRPC_CLIENT,
  FILE_API,
  FILE_GRPC_CLIENT,
  IDENTITY_GRPC_CLIENT,
  JWKS_SOURCE,
  NOTIFICATION_API,
  NOTIFICATION_GRPC_CLIENT,
  ORGANIZATIONS_API,
  PAYMENT_API,
  PAYMENT_GRPC_CLIENT,
  PAYMENT_SIMULATION_ROUTE,
  WALLET_API,
  WALLET_GRPC_CLIENT,
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
          grpcClientOptions(PAYMENT_GRPC_CLIENT, 'payment', config.PAYMENT_GRPC_URL),
          grpcClientOptions(NOTIFICATION_GRPC_CLIENT, 'notification', config.NOTIFICATION_GRPC_URL),
          grpcClientOptions(FILE_GRPC_CLIENT, 'file', config.FILE_GRPC_URL),
          grpcClientOptions(WALLET_GRPC_CLIENT, 'wallet', config.WALLET_GRPC_URL),
          grpcClientOptions(DOCUMENT_GRPC_CLIENT, 'document', config.DOCUMENT_GRPC_URL),
        ]),
      ],
      controllers: [
        HealthController,
        IdentityHttpController,
        JwksHttpController,
        OrganizationHttpController,
        OrganizationAdminHttpController,
        AccountAdminHttpController,
        CleaningHttpController,
        CleaningAdminHttpController,
        BillingHttpController,
        PaymentHttpController,
        NotificationHttpController,
        FileHttpController,
        WalletHttpController,
        DocumentHttpController,
      ],
      providers: [
        ReadinessRegistry,
        ShutdownState,
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
          provide: ORGANIZATIONS_API,
          inject: [IDENTITY_GRPC_CLIENT, SERVICE_TOKEN_PROVIDER],
          useFactory: (grpc: ClientGrpc, serviceTokens: ServiceTokenProvider | null): OrganizationsApi =>
            new OrganizationsGrpcAdapter(
              {
                auth: grpc.getService<identityV1.AuthServiceClient>(identityV1.AUTH_SERVICE_NAME),
                organizations: grpc.getService<identityV1.OrganizationServiceClient>(
                  identityV1.ORGANIZATION_SERVICE_NAME,
                ),
                admin: grpc.getService<identityV1.OrganizationAdminServiceClient>(
                  identityV1.ORGANIZATION_ADMIN_SERVICE_NAME,
                ),
              },
              // Appelant propre aux comptes entreprise : une panne ou un coupe-circuit ouvert ici ne
              // bloque pas la connexion ni le renouvellement des sessions (UC-GW-07).
              new GrpcCaller({
                target: 'identity',
                defaultDeadlineMs: config.GRPC_DEADLINE_MS,
                ...(serviceTokens ? { serviceTokenProvider: serviceTokens } : {}),
              }),
            ),
        },
        {
          provide: ACCOUNT_ADMIN_API,
          inject: [IDENTITY_GRPC_CLIENT, SERVICE_TOKEN_PROVIDER],
          useFactory: (grpc: ClientGrpc, serviceTokens: ServiceTokenProvider | null): AccountAdminApi =>
            new AccountAdminGrpcAdapter(
              grpc.getService<identityV1.AccountAdminServiceClient>(identityV1.ACCOUNT_ADMIN_SERVICE_NAME),
              // Appelant propre au back-office des comptes : sa panne ne bloque pas la connexion (UC-GW-07).
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
          provide: PAYMENT_API,
          inject: [PAYMENT_GRPC_CLIENT, SERVICE_TOKEN_PROVIDER],
          useFactory: (grpc: ClientGrpc, serviceTokens: ServiceTokenProvider | null): PaymentApi =>
            new PaymentGrpcAdapter(
              {
                payments: grpc.getService<paymentV1.PaymentServiceClient>(paymentV1.PAYMENT_SERVICE_NAME),
                webhooks: grpc.getService<paymentV1.PaymentWebhookServiceClient>(
                  paymentV1.PAYMENT_WEBHOOK_SERVICE_NAME,
                ),
                admin: grpc.getService<paymentV1.PaymentAdminServiceClient>(
                  paymentV1.PAYMENT_ADMIN_SERVICE_NAME,
                ),
                links: grpc.getService<paymentV1.PaymentLinkPublicServiceClient>(
                  paymentV1.PAYMENT_LINK_PUBLIC_SERVICE_NAME,
                ),
                payoutAdmin: grpc.getService<paymentV1.PayoutAdminServiceClient>(
                  paymentV1.PAYOUT_ADMIN_SERVICE_NAME,
                ),
              },
              // Coupe-circuit propre à payment : une panne n'affecte pas les autres routes (UC-GW-07).
              new GrpcCaller({
                target: 'payment',
                defaultDeadlineMs: config.GRPC_DEADLINE_MS,
                ...(serviceTokens ? { serviceTokenProvider: serviceTokens } : {}),
              }),
            ),
        },
        {
          provide: NOTIFICATION_API,
          inject: [NOTIFICATION_GRPC_CLIENT, SERVICE_TOKEN_PROVIDER],
          useFactory: (grpc: ClientGrpc, serviceTokens: ServiceTokenProvider | null): NotificationApi =>
            new NotificationGrpcAdapter(
              {
                center: grpc.getService<notificationV1.InAppNotificationServiceClient>(
                  notificationV1.IN_APP_NOTIFICATION_SERVICE_NAME,
                ),
                admin: grpc.getService<notificationV1.NotificationAdminServiceClient>(
                  notificationV1.NOTIFICATION_ADMIN_SERVICE_NAME,
                ),
              },
              // Coupe-circuit propre à notification : une panne n'affecte pas les autres routes (UC-GW-07).
              new GrpcCaller({
                target: 'notification',
                defaultDeadlineMs: config.GRPC_DEADLINE_MS,
                ...(serviceTokens ? { serviceTokenProvider: serviceTokens } : {}),
              }),
            ),
        },
        {
          provide: FILE_API,
          inject: [FILE_GRPC_CLIENT, SERVICE_TOKEN_PROVIDER],
          useFactory: (grpc: ClientGrpc, serviceTokens: ServiceTokenProvider | null): FileApi =>
            new FileGrpcAdapter(
              grpc.getService<fileV1.FileServiceClient>(fileV1.FILE_SERVICE_NAME),
              // Coupe-circuit propre à file : une panne n'affecte pas les autres routes (UC-GW-07).
              new GrpcCaller({
                target: 'file',
                defaultDeadlineMs: config.GRPC_DEADLINE_MS,
                ...(serviceTokens ? { serviceTokenProvider: serviceTokens } : {}),
              }),
            ),
        },
        {
          provide: WALLET_API,
          inject: [WALLET_GRPC_CLIENT, SERVICE_TOKEN_PROVIDER],
          useFactory: (grpc: ClientGrpc, serviceTokens: ServiceTokenProvider | null): WalletApi =>
            new WalletGrpcAdapter(
              {
                account: grpc.getService<walletV1.WalletAccountServiceClient>(
                  walletV1.WALLET_ACCOUNT_SERVICE_NAME,
                ),
                admin: grpc.getService<walletV1.WalletAdminServiceClient>(walletV1.WALLET_ADMIN_SERVICE_NAME),
              },
              // Coupe-circuit propre à wallet : une panne n'affecte pas les autres routes (UC-GW-07).
              new GrpcCaller({
                target: 'wallet',
                defaultDeadlineMs: config.GRPC_DEADLINE_MS,
                ...(serviceTokens ? { serviceTokenProvider: serviceTokens } : {}),
              }),
            ),
        },
        {
          provide: DOCUMENT_API,
          inject: [DOCUMENT_GRPC_CLIENT, SERVICE_TOKEN_PROVIDER],
          useFactory: (grpc: ClientGrpc, serviceTokens: ServiceTokenProvider | null): DocumentApi =>
            new DocumentGrpcAdapter(
              grpc.getService<documentV1.DocumentServiceClient>(documentV1.DOCUMENT_SERVICE_NAME),
              grpc.getService<documentV1.DocumentSigningServiceClient>(
                documentV1.DOCUMENT_SIGNING_SERVICE_NAME,
              ),
              // Coupe-circuit propre à document : une panne n'affecte pas les autres routes (UC-GW-07).
              new GrpcCaller({
                target: 'document',
                defaultDeadlineMs: config.GRPC_DEADLINE_MS,
                ...(serviceTokens ? { serviceTokenProvider: serviceTokens } : {}),
              }),
            ),
        },
        // Simulation des paiements : jamais en production (ADR-031).
        { provide: PAYMENT_SIMULATION_ROUTE, useValue: config.NODE_ENV !== 'production' },
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
              authenticatedIpLimitFrom(config),
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
        identityUseCase(RequestAccountDeletionUseCase),
        identityUseCase(CancelAccountDeletionUseCase),
        {
          provide: GetPublicKeysUseCase,
          inject: [SigningKeysCache],
          useFactory: (keys: SigningKeysCache) => new GetPublicKeysUseCase(keys),
        },
      ],
    };
  }
}
