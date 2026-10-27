import { notificationV1 } from '@ksp/contracts';
import { GrpcCaller, grpcClientOptions, PlatformModule } from '@ksp/platform';
import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { type ClientGrpc, ClientsModule } from '@nestjs/microservices';
import { GetMeUseCase, UpdateMeUseCase } from './application/account/account.use-cases';
import { ActiveContexts } from './application/context/active-contexts';
import { GetOrganizationsUseCase } from './application/directory/get-organizations.use-case';
import { GetUsersUseCase } from './application/directory/get-users.use-case';
import { ChangeEmailUseCase } from './application/email/change-email.use-case';
import { ConfirmEmailUseCase } from './application/email/confirm-email.use-case';
import { PendingEmails } from './application/email/pending-email';
import { BackofficeSessionOpener } from './application/mfa/backoffice-session-opener';
import { ConfirmTotpUseCase } from './application/mfa/confirm-totp.use-case';
import { EnrollTotpUseCase } from './application/mfa/enroll-totp.use-case';
import { MfaStepGuard } from './application/mfa/mfa-step-guard';
import { OpenMfaChallenge } from './application/mfa/open-mfa-challenge';
import { VerifyMfaUseCase } from './application/mfa/verify-mfa.use-case';
import {
  DecideOrganizationUseCase,
  GetOrganizationUseCase,
  ListOrganizationsUseCase,
} from './application/organization/organization-admin.use-cases';
import {
  ChangeOrganizationBillingEmailUseCase,
  ConfirmOrganizationBillingEmailUseCase,
  CreateOrganizationUseCase,
  GetMyOrganizationUseCase,
  ListMyOrganizationsUseCase,
} from './application/organization/organization.use-cases';
import { RequestOtpUseCase } from './application/otp/request-otp.use-case';
import { IssueServiceTokenUseCase } from './application/service-token/issue-service-token.use-case';
import { LogoutUseCase } from './application/session/logout.use-case';
import { RefreshSessionUseCase } from './application/session/refresh-session.use-case';
import { SwitchContextUseCase } from './application/session/switch-context.use-case';
import { VerifyOtpUseCase } from './application/session/verify-otp.use-case';
import { AccessTokenIssuer } from './application/token/access-token-issuer';
import { GetSigningKeysUseCase } from './application/token/get-signing-keys.use-case';
import {
  backofficeSessionPolicyFrom,
  emailOtpPolicyFrom,
  mfaPolicyFrom,
  otpPolicyFrom,
  type ServiceConfig,
  sessionPoliciesFrom,
  sessionPolicyFrom,
} from './config';
import { TOTP_DEFAULTS } from './domain/mfa/totp';
import { NotificationEmailCodeSender } from './infrastructure/email/notification-email-code-sender';
import { PrismaEmailVerificationRepository } from './infrastructure/email/prisma-email-verification.repository';
import { AesGcmSecretCipher } from './infrastructure/mfa/aes-gcm-secret-cipher';
import { CryptoMfaTokenGenerator, CryptoRecoveryCodes } from './infrastructure/mfa/crypto-mfa-secrets';
import { HmacTotpGenerator } from './infrastructure/mfa/hmac-totp-generator';
import { PrismaMfaRepository } from './infrastructure/mfa/prisma-mfa.repository';
import { PrismaRoleRepository } from './infrastructure/role/prisma-role.repository';
import { OutboxRelayService } from './infrastructure/messaging/outbox-relay.service';
import { PrismaOrganizationRepository } from './infrastructure/organization/prisma-organization.repository';
import { CryptoOtpCodeGenerator } from './infrastructure/otp/crypto-otp-code-generator';
import { HmacOtpHasher } from './infrastructure/otp/hmac-otp-hasher';
import { NotificationOtpSender } from './infrastructure/otp/notification-otp-sender';
import { PrismaOtpChallengeRepository } from './infrastructure/otp/prisma-otp-challenge.repository';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import { ConfigServiceClientRegistry } from './infrastructure/service-token/config-service-client-registry';
import { LocalServiceTokenProvider } from './infrastructure/service-token/local-service-token-provider';
import {
  CryptoRefreshTokenGenerator,
  hashRefreshToken,
} from './infrastructure/session/crypto-refresh-token-generator';
import { PrismaLoginRepository } from './infrastructure/session/prisma-login.repository';
import { PrismaSessionStore } from './infrastructure/session/prisma-session.store';
import { SystemClock, UuidV7Generator } from './infrastructure/system/system';
import { KeyRingSigner } from './infrastructure/token/key-ring-signer';
import { AccountGrpcController } from './interfaces/grpc/account.controller';
import { AuthGrpcController } from './interfaces/grpc/auth.controller';
import { IdentityGrpcController } from './interfaces/grpc/identity.controller';
import {
  OrganizationAdminGrpcController,
  OrganizationGrpcController,
} from './interfaces/grpc/organization.controllers';
import { JwksHttpController } from './interfaces/http/jwks.controller';
import { OAuthTokenHttpController } from './interfaces/http/oauth-token.controller';

const NOTIFICATION_CLIENT = Symbol('NOTIFICATION_CLIENT');
const OTP_SENDER = Symbol('OTP_SENDER');
const EMAIL_CODE_SENDER = Symbol('EMAIL_CODE_SENDER');
const TOKEN_SIGNER = Symbol('TOKEN_SIGNER');
const SECRET_CIPHER = Symbol('SECRET_CIPHER');

/** Racine de composition : relie chaque cas d'usage à ses adaptateurs. */
@Module({})
export class AppModule {
  static forRoot(config: ServiceConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        PlatformModule.forRoot(config),
        ClientsModule.register([
          grpcClientOptions(NOTIFICATION_CLIENT, 'notification', config.NOTIFICATION_GRPC_URL),
        ]),
      ],
      controllers: [
        IdentityGrpcController,
        AuthGrpcController,
        AccountGrpcController,
        OrganizationGrpcController,
        OrganizationAdminGrpcController,
        JwksHttpController,
        OAuthTokenHttpController,
      ],
      providers: [
        PrismaService,
        OutboxRelayService,
        PrismaOtpChallengeRepository,
        {
          // Chargé au démarrage : une configuration de clés invalide empêche le service de démarrer.
          provide: TOKEN_SIGNER,
          useFactory: async () => {
            const signer = await KeyRingSigner.fromConfig(config.IDENTITY_SIGNING_KEYS, config.NODE_ENV);
            if (signer.ephemeral) {
              new Logger('KeyRingSigner').warn(
                'Aucune clé configurée : clé de signature temporaire, les sessions ne survivront pas au redémarrage.',
              );
            }
            return signer;
          },
        },
        {
          provide: GetSigningKeysUseCase,
          inject: [TOKEN_SIGNER],
          useFactory: (signer: KeyRingSigner) => new GetSigningKeysUseCase(signer),
        },
        {
          provide: AccessTokenIssuer,
          inject: [TOKEN_SIGNER],
          useFactory: (signer: KeyRingSigner) =>
            new AccessTokenIssuer(
              signer,
              new UuidV7Generator(),
              new SystemClock(),
              config.ACCESS_TOKEN_TTL_SECONDS,
            ),
        },
        {
          provide: IssueServiceTokenUseCase,
          inject: [TOKEN_SIGNER],
          useFactory: (signer: KeyRingSigner) =>
            new IssueServiceTokenUseCase(
              ConfigServiceClientRegistry.fromConfig(config.SERVICE_CLIENTS),
              signer,
              new UuidV7Generator(),
              new SystemClock(),
              config.SERVICE_TOKEN_TTL_SECONDS,
            ),
        },
        {
          provide: OTP_SENDER,
          inject: [NOTIFICATION_CLIENT, IssueServiceTokenUseCase],
          useFactory: (grpc: ClientGrpc, serviceTokens: IssueServiceTokenUseCase) =>
            new NotificationOtpSender(
              grpc.getService<notificationV1.NotificationServiceClient>(
                notificationV1.NOTIFICATION_SERVICE_NAME,
              ),
              new GrpcCaller({
                target: 'notification',
                serviceTokenProvider: new LocalServiceTokenProvider(serviceTokens),
              }),
            ),
        },
        {
          provide: RequestOtpUseCase,
          inject: [PrismaOtpChallengeRepository, OTP_SENDER],
          useFactory: (challenges: PrismaOtpChallengeRepository, sender: NotificationOtpSender) =>
            new RequestOtpUseCase(
              challenges,
              sender,
              new HmacOtpHasher(config.OTP_HMAC_SECRET),
              new CryptoOtpCodeGenerator(),
              new UuidV7Generator(),
              new SystemClock(),
              otpPolicyFrom(config),
            ),
        },
        PrismaLoginRepository,
        PrismaRoleRepository,
        PrismaMfaRepository,
        {
          // Chargée au démarrage : une clé absente en production empêche le service de démarrer.
          provide: SECRET_CIPHER,
          useFactory: () => {
            const cipher = AesGcmSecretCipher.fromConfig(config.IDENTITY_MFA_ENCRYPTION_KEY, config.NODE_ENV);
            if (cipher.ephemeral) {
              new Logger('AesGcmSecretCipher').warn(
                "Aucune clé de chiffrement configurée : clé temporaire, les applications d'authentification configurées ne survivront pas au redémarrage.",
              );
            }
            return cipher;
          },
        },
        {
          provide: OpenMfaChallenge,
          inject: [PrismaRoleRepository, PrismaMfaRepository],
          useFactory: (roles: PrismaRoleRepository, mfa: PrismaMfaRepository) =>
            new OpenMfaChallenge(
              roles,
              mfa,
              mfa,
              new CryptoMfaTokenGenerator(),
              new UuidV7Generator(),
              mfaPolicyFrom(config),
            ),
        },
        {
          provide: MfaStepGuard,
          inject: [PrismaMfaRepository, PrismaLoginRepository, PrismaRoleRepository],
          useFactory: (
            mfa: PrismaMfaRepository,
            logins: PrismaLoginRepository,
            roles: PrismaRoleRepository,
          ) =>
            new MfaStepGuard(
              mfa,
              new CryptoMfaTokenGenerator(),
              logins,
              roles,
              logins,
              new UuidV7Generator(),
              mfaPolicyFrom(config),
            ),
        },
        {
          provide: BackofficeSessionOpener,
          inject: [PrismaMfaRepository, AccessTokenIssuer],
          useFactory: (mfa: PrismaMfaRepository, accessTokens: AccessTokenIssuer) =>
            new BackofficeSessionOpener(
              mfa,
              new CryptoRefreshTokenGenerator(),
              accessTokens,
              new UuidV7Generator(),
              backofficeSessionPolicyFrom(config),
            ),
        },
        {
          provide: EnrollTotpUseCase,
          inject: [MfaStepGuard, PrismaMfaRepository, SECRET_CIPHER],
          useFactory: (guard: MfaStepGuard, mfa: PrismaMfaRepository, cipher: AesGcmSecretCipher) =>
            new EnrollTotpUseCase(
              guard,
              mfa,
              new HmacTotpGenerator(),
              cipher,
              new UuidV7Generator(),
              new SystemClock(),
              TOTP_DEFAULTS,
            ),
        },
        {
          provide: ConfirmTotpUseCase,
          inject: [MfaStepGuard, PrismaMfaRepository, SECRET_CIPHER, BackofficeSessionOpener],
          useFactory: (
            guard: MfaStepGuard,
            mfa: PrismaMfaRepository,
            cipher: AesGcmSecretCipher,
            opener: BackofficeSessionOpener,
          ) => {
            const recoveryCodes = new CryptoRecoveryCodes(config.OTP_HMAC_SECRET);
            return new ConfirmTotpUseCase(
              guard,
              mfa,
              new HmacTotpGenerator(),
              cipher,
              recoveryCodes,
              recoveryCodes,
              opener,
              new UuidV7Generator(),
              new SystemClock(),
              TOTP_DEFAULTS,
            );
          },
        },
        {
          provide: VerifyMfaUseCase,
          inject: [MfaStepGuard, PrismaMfaRepository, SECRET_CIPHER, BackofficeSessionOpener],
          useFactory: (
            guard: MfaStepGuard,
            mfa: PrismaMfaRepository,
            cipher: AesGcmSecretCipher,
            opener: BackofficeSessionOpener,
          ) =>
            new VerifyMfaUseCase(
              guard,
              mfa,
              new HmacTotpGenerator(),
              cipher,
              new CryptoRecoveryCodes(config.OTP_HMAC_SECRET),
              opener,
              new SystemClock(),
              TOTP_DEFAULTS,
            ),
        },
        {
          provide: VerifyOtpUseCase,
          inject: [PrismaOtpChallengeRepository, PrismaLoginRepository, AccessTokenIssuer, OpenMfaChallenge],
          useFactory: (
            challenges: PrismaOtpChallengeRepository,
            logins: PrismaLoginRepository,
            accessTokens: AccessTokenIssuer,
            mfa: OpenMfaChallenge,
          ) =>
            new VerifyOtpUseCase(
              challenges,
              logins,
              logins,
              new HmacOtpHasher(config.OTP_HMAC_SECRET),
              new CryptoRefreshTokenGenerator(),
              accessTokens,
              new UuidV7Generator(),
              new SystemClock(),
              otpPolicyFrom(config),
              sessionPolicyFrom(config),
              mfa,
            ),
        },
        PrismaSessionStore,
        PrismaOrganizationRepository,
        {
          provide: RefreshSessionUseCase,
          inject: [PrismaSessionStore, AccessTokenIssuer, PrismaRoleRepository, PrismaOrganizationRepository],
          useFactory: (
            sessions: PrismaSessionStore,
            accessTokens: AccessTokenIssuer,
            roles: PrismaRoleRepository,
            organizations: PrismaOrganizationRepository,
          ) =>
            new RefreshSessionUseCase(
              sessions,
              new CryptoRefreshTokenGenerator(),
              hashRefreshToken,
              accessTokens,
              new UuidV7Generator(),
              new SystemClock(),
              sessionPoliciesFrom(config),
              roles,
              organizations,
            ),
        },
        {
          provide: SwitchContextUseCase,
          inject: [PrismaSessionStore, PrismaOrganizationRepository, AccessTokenIssuer],
          useFactory: (
            sessions: PrismaSessionStore,
            organizations: PrismaOrganizationRepository,
            accessTokens: AccessTokenIssuer,
          ) => new SwitchContextUseCase(sessions, organizations, accessTokens, new SystemClock()),
        },
        {
          provide: ActiveContexts,
          inject: [PrismaOrganizationRepository],
          useFactory: (organizations: PrismaOrganizationRepository) => new ActiveContexts(organizations),
        },
        {
          provide: LogoutUseCase,
          inject: [PrismaSessionStore],
          useFactory: (sessions: PrismaSessionStore) => new LogoutUseCase(sessions, new SystemClock()),
        },
        PrismaEmailVerificationRepository,
        {
          provide: PendingEmails,
          inject: [PrismaEmailVerificationRepository],
          useFactory: (verifications: PrismaEmailVerificationRepository) =>
            new PendingEmails(verifications, new SystemClock(), emailOtpPolicyFrom(config).maxAttempts),
        },
        {
          provide: GetMeUseCase,
          inject: [PrismaLoginRepository, PendingEmails, ActiveContexts],
          useFactory: (
            accounts: PrismaLoginRepository,
            pendingEmails: PendingEmails,
            contexts: ActiveContexts,
          ) => new GetMeUseCase(accounts, pendingEmails, contexts),
        },
        {
          provide: GetUsersUseCase,
          inject: [PrismaLoginRepository],
          useFactory: (directory: PrismaLoginRepository) => new GetUsersUseCase(directory),
        },
        {
          provide: GetOrganizationsUseCase,
          inject: [PrismaOrganizationRepository],
          useFactory: (directory: PrismaOrganizationRepository) => new GetOrganizationsUseCase(directory),
        },
        {
          provide: UpdateMeUseCase,
          inject: [PrismaLoginRepository, PendingEmails, ActiveContexts],
          useFactory: (
            accounts: PrismaLoginRepository,
            pendingEmails: PendingEmails,
            contexts: ActiveContexts,
          ) => new UpdateMeUseCase(accounts, pendingEmails, contexts),
        },
        {
          provide: EMAIL_CODE_SENDER,
          inject: [NOTIFICATION_CLIENT, IssueServiceTokenUseCase],
          useFactory: (grpc: ClientGrpc, serviceTokens: IssueServiceTokenUseCase) =>
            new NotificationEmailCodeSender(
              grpc.getService<notificationV1.NotificationServiceClient>(
                notificationV1.NOTIFICATION_SERVICE_NAME,
              ),
              new GrpcCaller({
                target: 'notification',
                serviceTokenProvider: new LocalServiceTokenProvider(serviceTokens),
              }),
            ),
        },
        {
          provide: ChangeEmailUseCase,
          inject: [PrismaLoginRepository, PrismaEmailVerificationRepository, EMAIL_CODE_SENDER],
          useFactory: (
            accounts: PrismaLoginRepository,
            verifications: PrismaEmailVerificationRepository,
            sender: NotificationEmailCodeSender,
          ) =>
            new ChangeEmailUseCase(
              accounts,
              verifications,
              sender,
              new HmacOtpHasher(config.OTP_HMAC_SECRET),
              new CryptoOtpCodeGenerator(),
              new UuidV7Generator(),
              new SystemClock(),
              emailOtpPolicyFrom(config),
            ),
        },
        {
          provide: ConfirmEmailUseCase,
          inject: [PrismaLoginRepository, PrismaEmailVerificationRepository, ActiveContexts],
          useFactory: (
            accounts: PrismaLoginRepository,
            verifications: PrismaEmailVerificationRepository,
            contexts: ActiveContexts,
          ) =>
            new ConfirmEmailUseCase(
              accounts,
              verifications,
              new HmacOtpHasher(config.OTP_HMAC_SECRET),
              new SystemClock(),
              emailOtpPolicyFrom(config),
              contexts,
            ),
        },
        {
          provide: CreateOrganizationUseCase,
          inject: [PrismaOrganizationRepository, PendingEmails],
          useFactory: (organizations: PrismaOrganizationRepository, pendingEmails: PendingEmails) =>
            new CreateOrganizationUseCase(
              organizations,
              pendingEmails,
              new UuidV7Generator(),
              new SystemClock(),
            ),
        },
        {
          provide: ListMyOrganizationsUseCase,
          inject: [PrismaOrganizationRepository, PendingEmails],
          useFactory: (organizations: PrismaOrganizationRepository, pendingEmails: PendingEmails) =>
            new ListMyOrganizationsUseCase(organizations, pendingEmails),
        },
        {
          provide: GetMyOrganizationUseCase,
          inject: [PrismaOrganizationRepository, PendingEmails],
          useFactory: (organizations: PrismaOrganizationRepository, pendingEmails: PendingEmails) =>
            new GetMyOrganizationUseCase(organizations, pendingEmails),
        },
        {
          provide: ChangeOrganizationBillingEmailUseCase,
          inject: [PrismaOrganizationRepository, PrismaEmailVerificationRepository, EMAIL_CODE_SENDER],
          useFactory: (
            organizations: PrismaOrganizationRepository,
            verifications: PrismaEmailVerificationRepository,
            sender: NotificationEmailCodeSender,
          ) =>
            new ChangeOrganizationBillingEmailUseCase(
              organizations,
              verifications,
              sender,
              new HmacOtpHasher(config.OTP_HMAC_SECRET),
              new CryptoOtpCodeGenerator(),
              new UuidV7Generator(),
              new SystemClock(),
              emailOtpPolicyFrom(config),
            ),
        },
        {
          provide: ConfirmOrganizationBillingEmailUseCase,
          inject: [PrismaOrganizationRepository, PrismaEmailVerificationRepository, PendingEmails],
          useFactory: (
            organizations: PrismaOrganizationRepository,
            verifications: PrismaEmailVerificationRepository,
            pendingEmails: PendingEmails,
          ) =>
            new ConfirmOrganizationBillingEmailUseCase(
              organizations,
              verifications,
              pendingEmails,
              new HmacOtpHasher(config.OTP_HMAC_SECRET),
              new SystemClock(),
              emailOtpPolicyFrom(config),
            ),
        },
        {
          provide: ListOrganizationsUseCase,
          inject: [PrismaOrganizationRepository],
          useFactory: (organizations: PrismaOrganizationRepository) =>
            new ListOrganizationsUseCase(organizations),
        },
        {
          provide: GetOrganizationUseCase,
          inject: [PrismaOrganizationRepository],
          useFactory: (organizations: PrismaOrganizationRepository) =>
            new GetOrganizationUseCase(organizations),
        },
        {
          provide: DecideOrganizationUseCase,
          inject: [PrismaOrganizationRepository],
          useFactory: (organizations: PrismaOrganizationRepository) =>
            new DecideOrganizationUseCase(organizations, new UuidV7Generator(), new SystemClock()),
        },
      ],
    };
  }
}
