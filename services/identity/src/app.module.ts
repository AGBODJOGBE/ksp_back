import { notificationV1 } from '@ksp/contracts';
import { GrpcCaller, grpcClientOptions, PlatformModule } from '@ksp/platform';
import { type DynamicModule, Module } from '@nestjs/common';
import { type ClientGrpc, ClientsModule } from '@nestjs/microservices';
import { RequestOtpUseCase } from './application/otp/request-otp.use-case';
import { otpPolicyFrom, type ServiceConfig } from './config';
import { OutboxRelayService } from './infrastructure/messaging/outbox-relay.service';
import { CryptoOtpCodeGenerator } from './infrastructure/otp/crypto-otp-code-generator';
import { HmacOtpHasher } from './infrastructure/otp/hmac-otp-hasher';
import { NotificationOtpSender } from './infrastructure/otp/notification-otp-sender';
import { PrismaOtpChallengeRepository } from './infrastructure/otp/prisma-otp-challenge.repository';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import { SystemClock, UuidV7Generator } from './infrastructure/system/system';
import { AccountGrpcController } from './interfaces/grpc/account.controller';
import { AuthGrpcController } from './interfaces/grpc/auth.controller';
import { IdentityGrpcController } from './interfaces/grpc/identity.controller';

const NOTIFICATION_CLIENT = Symbol('NOTIFICATION_CLIENT');
const OTP_SENDER = Symbol('OTP_SENDER');

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
      controllers: [IdentityGrpcController, AuthGrpcController, AccountGrpcController],
      providers: [
        PrismaService,
        OutboxRelayService,
        PrismaOtpChallengeRepository,
        {
          provide: OTP_SENDER,
          inject: [NOTIFICATION_CLIENT],
          useFactory: (grpc: ClientGrpc) =>
            new NotificationOtpSender(
              grpc.getService<notificationV1.NotificationServiceClient>(
                notificationV1.NOTIFICATION_SERVICE_NAME,
              ),
              new GrpcCaller({ target: 'notification' }),
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
