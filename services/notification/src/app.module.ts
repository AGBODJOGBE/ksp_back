import { PlatformModule } from '@ksp/platform';
import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { SendNotificationUseCase } from './application/send/send-notification.use-case';
import { type ServiceConfig, whatsappProviderKind } from './config';
import { createChannelProviders } from './infrastructure/channels/channel-providers';
import { OutboxRelayService } from './infrastructure/messaging/outbox-relay.service';
import { PrismaNotificationRepository } from './infrastructure/notification/prisma-notification.repository';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import { SystemClock, UuidV7Generator } from './infrastructure/system/system';
import { NotificationGrpcController } from './interfaces/grpc/notification.controller';

/** Racine de composition : relie chaque cas d'usage à ses adaptateurs. */
@Module({})
export class AppModule {
  static forRoot(config: ServiceConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [PlatformModule.forRoot(config)],
      controllers: [NotificationGrpcController],
      providers: [
        PrismaService,
        OutboxRelayService,
        PrismaNotificationRepository,
        {
          provide: SendNotificationUseCase,
          inject: [PrismaNotificationRepository],
          useFactory: (notifications: PrismaNotificationRepository) => {
            // Lève une erreur (le service ne démarre pas) si le prestataire console est choisi en production.
            const providers = createChannelProviders(config);
            if (whatsappProviderKind(config) === 'console') {
              new Logger('Notification').warn(
                'Prestataire WhatsApp « console » : les codes sont écrits dans le terminal, aucun message ne part (développement uniquement).',
              );
            }
            return new SendNotificationUseCase(
              notifications,
              providers,
              new SystemClock(),
              new UuidV7Generator(),
            );
          },
        },
      ],
    };
  }
}
