import { notificationV1 } from '@ksp/contracts';
import { GrpcCaller, grpcClientOptions, PlatformModule } from '@ksp/platform';
import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { type ClientGrpc, ClientsModule } from '@nestjs/microservices';
import { RequestOtpUseCase } from './application/otp/request-otp.use-case';
import { IssueServiceTokenUseCase } from './application/service-token/issue-service-token.use-case';
import { AccessTokenIssuer } from './application/token/access-token-issuer';
import { GetSigningKeysUseCase } from './application/token/get-signing-keys.use-case';
import { otpPolicyFrom, type ServiceConfig } from './config';
import { OutboxRelayService } from './infrastructure/messaging/outbox-relay.service';
import { CryptoOtpCodeGenerator } from './infrastructure/otp/crypto-otp-code-generator';
import { HmacOtpHasher } from './infrastructure/otp/hmac-otp-hasher';
import { NotificationOtpSender } from './infrastructure/otp/notification-otp-sender';
import { PrismaOtpChallengeRepository } from './infrastructure/otp/prisma-otp-challenge.repository';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import { ConfigServiceClientRegistry } from './infrastructure/service-token/config-service-client-registry';
import { LocalServiceTokenProvider } from './infrastructure/service-token/local-service-token-provider';
import { SystemClock, UuidV7Generator } from './infrastructure/system/system';
import { KeyRingSigner } from './infrastructure/token/key-ring-signer';
import { AccountGrpcController } from './interfaces/grpc/account.controller';
import { AuthGrpcController } from './interfaces/grpc/auth.controller';
import { IdentityGrpcController } from './interfaces/grpc/identity.controller';
import { JwksHttpController } from './interfaces/http/jwks.controller';
import { OAuthTokenHttpController } from './interfaces/http/oauth-token.controller';

const NOTIFICATION_CLIENT = Symbol('NOTIFICATION_CLIENT');
const OTP_SENDER = Symbol('OTP_SENDER');
const TOKEN_SIGNER = Symbol('TOKEN_SIGNER');

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
      ],
    };
  }
}
