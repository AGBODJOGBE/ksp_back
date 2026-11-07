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
import {
  CountMyUnreadNotificationsUseCase,
  GetDeliveryUseCase,
  GetMyNotificationPreferencesUseCase,
  ListDeliveriesUseCase,
  ListMessageTemplatesUseCase,
  ListMyNotificationsUseCase,
  MarkAllNotificationsReadUseCase,
  MarkNotificationReadUseCase,
  UpdateMyNotificationPreferencesUseCase,
} from './application/center/center.use-cases';
import { EVENT_RULES } from './application/events/listened-events';
import { NotifyEventUseCase } from './application/events/notify-event.use-case';
import { EraseUserNotificationsUseCase } from './application/privacy/erase-user-notifications.use-case';
import { type ChannelProvider } from './application/send/notification.ports';
import { MessageDispatcher } from './application/send/message-dispatcher';
import { SendNotificationUseCase } from './application/send/send-notification.use-case';
import { emailProviderKind, type ServiceConfig, whatsappProviderKind } from './config';
import { PrismaDeliveryHistory } from './infrastructure/center/prisma-delivery-history';
import { PrismaInAppNotifications } from './infrastructure/center/prisma-in-app-notifications';
import { PrismaPreferences } from './infrastructure/center/prisma-preferences';
import { createChannelProviders } from './infrastructure/channels/channel-providers';
import { PrismaEventInbox } from './infrastructure/events/prisma-event-inbox';
import { IdentityOrganizationDirectory } from './infrastructure/identity/identity-organization-directory';
import { IdentityRecipientDirectory } from './infrastructure/identity/identity-recipient-directory';
import { OutboxRelayService } from './infrastructure/messaging/outbox-relay.service';
import { PrismaNotificationRepository } from './infrastructure/notification/prisma-notification.repository';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import { PrismaUserNotificationsEraser } from './infrastructure/privacy/prisma-user-notifications-eraser';
import { SystemClock, UuidV7Generator } from './infrastructure/system/system';
import {
  InAppNotificationGrpcController,
  NotificationAdminGrpcController,
} from './interfaces/grpc/notification-center.controller';
import { NotificationGrpcController } from './interfaces/grpc/notification.controller';
import { AccountErasureConsumer } from './interfaces/messaging/account-erasure.consumer';
import { EventNotificationsConsumer } from './interfaces/messaging/event-notifications.consumer';

const CHANNEL_PROVIDERS = Symbol('CHANNEL_PROVIDERS');
const IDENTITY_CLIENT = Symbol('IDENTITY_CLIENT');

/** Cas d'usage du centre de notifications (ADR-039), reliés aux dépôts Prisma. */
function centerUseCases(config: ServiceConfig) {
  const clock = new SystemClock();
  const withStore = <T>(UseCase: new (store: PrismaInAppNotifications, clock: SystemClock) => T) => ({
    provide: UseCase,
    inject: [PrismaInAppNotifications],
    useFactory: (store: PrismaInAppNotifications) => new UseCase(store, clock),
  });
  return [
    withStore(ListMyNotificationsUseCase),
    withStore(CountMyUnreadNotificationsUseCase),
    withStore(MarkNotificationReadUseCase),
    withStore(MarkAllNotificationsReadUseCase),
    {
      provide: GetMyNotificationPreferencesUseCase,
      inject: [PrismaPreferences],
      useFactory: (preferences: PrismaPreferences) => new GetMyNotificationPreferencesUseCase(preferences),
    },
    {
      provide: UpdateMyNotificationPreferencesUseCase,
      inject: [PrismaPreferences],
      useFactory: (preferences: PrismaPreferences) =>
        new UpdateMyNotificationPreferencesUseCase(preferences, clock),
    },
    {
      provide: ListDeliveriesUseCase,
      inject: [PrismaDeliveryHistory],
      useFactory: (history: PrismaDeliveryHistory) =>
        new ListDeliveriesUseCase(history, clock, config.NOTIFICATION_TIME_ZONE),
    },
    {
      provide: GetDeliveryUseCase,
      inject: [PrismaDeliveryHistory],
      useFactory: (history: PrismaDeliveryHistory) => new GetDeliveryUseCase(history, clock),
    },
    { provide: ListMessageTemplatesUseCase, useFactory: () => new ListMessageTemplatesUseCase(clock) },
  ];
}

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
      controllers: [
        NotificationGrpcController,
        InAppNotificationGrpcController,
        NotificationAdminGrpcController,
      ],
      providers: [
        PrismaService,
        OutboxRelayService,
        PrismaNotificationRepository,
        PrismaEventInbox,
        PrismaInAppNotifications,
        PrismaPreferences,
        PrismaDeliveryHistory,
        // Centre de notifications (ADR-039) : espace KSP, préférences, back-office.
        ...centerUseCases(config),
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
            PrismaPreferences,
            PrismaEventInbox,
            { token: SERVICE_TOKEN_PROVIDER, optional: true },
          ],
          useFactory: (
            notifications: PrismaNotificationRepository,
            providers: ChannelProvider[],
            grpc: ClientGrpc,
            preferences: PrismaPreferences,
            inbox: PrismaEventInbox,
            serviceTokens: ServiceTokenProvider | undefined,
          ) => {
            if (!serviceTokens) {
              new Logger('Notification').warn(
                'Aucun jeton de service : appels vers identity non authentifiés (développement uniquement).',
              );
            }
            const clock = new SystemClock();
            const identity = grpc.getService<identityV1.IdentityServiceClient>(
              identityV1.IDENTITY_SERVICE_NAME,
            );
            // Un seul appelant (délai, coupe-circuit) pour les deux lectures d'identity.
            const identityCaller = new GrpcCaller({
              target: 'identity',
              ...(serviceTokens ? { serviceTokenProvider: serviceTokens } : {}),
            });
            return new NotifyEventUseCase(
              EVENT_RULES,
              new MessageDispatcher(notifications, providers, clock),
              new IdentityRecipientDirectory(identity, identityCaller),
              new IdentityOrganizationDirectory(identity, identityCaller),
              preferences,
              inbox,
              clock,
              new UuidV7Generator(),
              {
                portalBaseUrl: config.PORTAL_BASE_URL.replace(/\/+$/, ''),
                timeZone: config.NOTIFICATION_TIME_ZONE,
                cleaningTeamUserIds: config.NOTIFICATION_CLEANING_TEAM_USER_IDS,
                accountsTeamUserIds: config.NOTIFICATION_ACCOUNTS_TEAM_USER_IDS,
              },
            );
          },
        },
        PrismaUserNotificationsEraser,
        {
          provide: EraseUserNotificationsUseCase,
          inject: [PrismaUserNotificationsEraser],
          useFactory: (eraser: PrismaUserNotificationsEraser) => new EraseUserNotificationsUseCase(eraser),
        },
        EventNotificationsConsumer,
        AccountErasureConsumer,
      ],
    };
  }
}
