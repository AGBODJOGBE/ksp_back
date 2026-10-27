import { identityV1 } from '@ksp/contracts';
import {
  GrpcCaller,
  grpcClientOptions,
  PlatformModule,
  SERVICE_TOKEN_PROVIDER,
  type ServiceTokenProvider,
} from '@ksp/platform';
import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { type ClientGrpc, ClientsModule } from '@nestjs/microservices';
import { EVENT_RULES } from './application/events/listened-events';
import { NotifyEventUseCase } from './application/events/notify-event.use-case';
import { type ChannelProvider } from './application/send/notification.ports';
import { MessageDispatcher } from './application/send/message-dispatcher';
import { SendNotificationUseCase } from './application/send/send-notification.use-case';
import { emailProviderKind, type ServiceConfig, whatsappProviderKind } from './config';
import { createChannelProviders } from './infrastructure/channels/channel-providers';
import { PrismaEventInbox } from './infrastructure/events/prisma-event-inbox';
import { IdentityRecipientDirectory } from './infrastructure/identity/identity-recipient-directory';
import { OutboxRelayService } from './infrastructure/messaging/outbox-relay.service';
import { PrismaNotificationRepository } from './infrastructure/notification/prisma-notification.repository';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import { SystemClock, UuidV7Generator } from './infrastructure/system/system';
import { NotificationGrpcController } from './interfaces/grpc/notification.controller';
import { EventNotificationsConsumer } from './interfaces/messaging/event-notifications.consumer';

const CHANNEL_PROVIDERS = Symbol('CHANNEL_PROVIDERS');
const IDENTITY_CLIENT = Symbol('IDENTITY_CLIENT');

/** Racine de composition : relie chaque cas d'usage à ses adaptateurs. */
@Module({})
export class AppModule {
  static forRoot(config: ServiceConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        PlatformModule.forRoot(config),
        ClientsModule.register([grpcClientOptions(IDENTITY_CLIENT, 'identity', config.IDENTITY_GRPC_URL)]),
      ],
      controllers: [NotificationGrpcController],
      providers: [
        PrismaService,
        OutboxRelayService,
        PrismaNotificationRepository,
        PrismaEventInbox,
        {
          // Lève une erreur (le service ne démarre pas) si un prestataire console est choisi en production.
          provide: CHANNEL_PROVIDERS,
          useFactory: (): ChannelProvider[] => {
            const providers = createChannelProviders(config);
            const logger = new Logger('Notification');
            if (whatsappProviderKind(config) === 'console') {
              logger.warn(
                'Prestataire WhatsApp « console » : les codes sont écrits dans le terminal, aucun message ne part (développement uniquement).',
              );
            }
            if (emailProviderKind(config) === 'console') {
              logger.warn(
                'Prestataire e-mail « console » : les e-mails sont écrits dans le terminal, aucun ne part (développement uniquement).',
              );
            }
            return providers;
          },
        },
        {
          provide: SendNotificationUseCase,
          inject: [PrismaNotificationRepository, CHANNEL_PROVIDERS],
          useFactory: (notifications: PrismaNotificationRepository, providers: ChannelProvider[]) =>
            new SendNotificationUseCase(notifications, providers, new SystemClock(), new UuidV7Generator()),
        },
        {
          provide: NotifyEventUseCase,
          inject: [
            PrismaNotificationRepository,
            CHANNEL_PROVIDERS,
            IDENTITY_CLIENT,
            PrismaEventInbox,
            { token: SERVICE_TOKEN_PROVIDER, optional: true },
          ],
          useFactory: (
            notifications: PrismaNotificationRepository,
            providers: ChannelProvider[],
            grpc: ClientGrpc,
            inbox: PrismaEventInbox,
            serviceTokens: ServiceTokenProvider | undefined,
          ) => {
            if (!serviceTokens) {
              new Logger('Notification').warn(
                'Aucun jeton de service : appels vers identity non authentifiés (développement uniquement).',
              );
            }
            const clock = new SystemClock();
            return new NotifyEventUseCase(
              EVENT_RULES,
              new MessageDispatcher(notifications, providers, clock),
              new IdentityRecipientDirectory(
                grpc.getService<identityV1.IdentityServiceClient>(identityV1.IDENTITY_SERVICE_NAME),
                new GrpcCaller({
                  target: 'identity',
                  ...(serviceTokens ? { serviceTokenProvider: serviceTokens } : {}),
                }),
              ),
              inbox,
              clock,
              new UuidV7Generator(),
              {
                portalBaseUrl: config.PORTAL_BASE_URL.replace(/\/+$/, ''),
                timeZone: config.NOTIFICATION_TIME_ZONE,
                cleaningTeamUserIds: config.NOTIFICATION_CLEANING_TEAM_USER_IDS,
              },
            );
          },
        },
        EventNotificationsConsumer,
      ],
    };
  }
}
