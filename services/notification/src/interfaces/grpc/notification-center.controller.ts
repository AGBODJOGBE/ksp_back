import { notificationV1 } from '@ksp/contracts';
import { Controller } from '@nestjs/common';
import {
  type DeliveryRecord,
  type StoredInAppNotification,
  type StoredPreferences,
} from '../../application/center/center.ports';
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
} from '../../application/center/center.use-cases';
import { type TemplatePreview } from '../../domain/catalog';

const iso = (value: Date | null): string => (value ? value.toISOString() : '');

export function presentInAppNotification(value: StoredInAppNotification): notificationV1.InAppNotification {
  return {
    id: value.id,
    templateCode: value.templateCode,
    title: value.title,
    body: value.body,
    link: value.link ?? '',
    createdAt: iso(value.createdAt),
    readAt: iso(value.readAt),
  };
}

export function presentPreferences(value: StoredPreferences): notificationV1.NotificationPreferences {
  return { whatsapp: value.whatsapp, email: value.email, updatedAt: iso(value.updatedAt) };
}

export function presentDelivery(value: DeliveryRecord): notificationV1.Delivery {
  return {
    id: value.id,
    templateCode: value.templateCode,
    requestedChannel: value.requestedChannel,
    channelUsed: value.channelUsed ?? '',
    channelsTried: [...value.channelsTried],
    targetMasked: value.targetMasked,
    recipientUserId: value.recipientUserId ?? '',
    status: value.status,
    errorCode: value.errorCode ?? '',
    failureReason: value.failureReason ?? '',
    providerMessageId: value.providerMessageId ?? '',
    createdAt: iso(value.createdAt),
    expiresAt: iso(value.expiresAt),
    acceptedAt: iso(value.acceptedAt),
    failedAt: iso(value.failedAt),
    erased: value.erased,
  };
}

export function presentTemplate(value: TemplatePreview): notificationV1.MessageTemplate {
  return {
    code: value.code,
    kind: value.kind,
    channels: [...value.channels],
    secret: value.secret,
    optional: value.optional,
    variables: [...value.variables],
    optionalVariables: [...value.optionalVariables],
    subject: value.subject ?? '',
    text: value.text ?? '',
  };
}

/**
 * Centre de notifications de l'espace KSP (ADR-038) : l'utilisateur vient du contexte de la
 * requête, posé par la gateway. Aucune règle métier ici.
 */
@Controller()
@notificationV1.InAppNotificationServiceControllerMethods()
export class InAppNotificationGrpcController implements notificationV1.InAppNotificationServiceController {
  constructor(
    private readonly listMy: ListMyNotificationsUseCase,
    private readonly countUnread: CountMyUnreadNotificationsUseCase,
    private readonly markOne: MarkNotificationReadUseCase,
    private readonly markAll: MarkAllNotificationsReadUseCase,
    private readonly getPreferences: GetMyNotificationPreferencesUseCase,
    private readonly updatePreferences: UpdateMyNotificationPreferencesUseCase,
  ) {}

  async listMyNotifications(
    request: notificationV1.ListMyNotificationsRequest,
  ): Promise<notificationV1.ListMyNotificationsResponse> {
    const page = await this.listMy.execute({
      page: request.page,
      unreadOnly: request.unreadOnly,
    });
    return {
      notifications: page.items.map(presentInAppNotification),
      nextCursor: page.nextCursor ?? '',
      unreadCount: page.unreadCount,
    };
  }

  async countMyUnreadNotifications(): Promise<notificationV1.CountMyUnreadNotificationsResponse> {
    return { unreadCount: await this.countUnread.execute() };
  }

  async markNotificationRead(
    request: notificationV1.MarkNotificationReadRequest,
  ): Promise<notificationV1.MarkNotificationReadResponse> {
    const result = await this.markOne.execute(request.notificationId);
    return { notification: presentInAppNotification(result.notification), unreadCount: result.unreadCount };
  }

  async markAllNotificationsRead(): Promise<notificationV1.MarkAllNotificationsReadResponse> {
    return this.markAll.execute();
  }

  async getMyNotificationPreferences(): Promise<notificationV1.GetMyNotificationPreferencesResponse> {
    return { preferences: presentPreferences(await this.getPreferences.execute()) };
  }

  async updateMyNotificationPreferences(
    request: notificationV1.UpdateMyNotificationPreferencesRequest,
  ): Promise<notificationV1.UpdateMyNotificationPreferencesResponse> {
    const saved = await this.updatePreferences.execute({ whatsapp: request.whatsapp, email: request.email });
    return { preferences: presentPreferences(saved) };
  }
}

/** Back-office des notifications (ADR-038) : droits vérifiés par les cas d'usage. */
@Controller()
@notificationV1.NotificationAdminServiceControllerMethods()
export class NotificationAdminGrpcController implements notificationV1.NotificationAdminServiceController {
  constructor(
    private readonly listDeliveriesUseCase: ListDeliveriesUseCase,
    private readonly getDeliveryUseCase: GetDeliveryUseCase,
    private readonly listTemplates: ListMessageTemplatesUseCase,
  ) {}

  async listDeliveries(
    request: notificationV1.ListDeliveriesRequest,
  ): Promise<notificationV1.ListDeliveriesResponse> {
    const page = await this.listDeliveriesUseCase.execute({
      page: request.page,
      filters: {
        templateCode: request.templateCode,
        channel: request.channel,
        status: request.status,
        from: request.from,
        to: request.to,
        recipientUserId: request.recipientUserId,
      },
    });
    return { deliveries: page.items.map(presentDelivery), nextCursor: page.nextCursor ?? '' };
  }

  async getDelivery(request: notificationV1.GetDeliveryRequest): Promise<notificationV1.GetDeliveryResponse> {
    return { delivery: presentDelivery(await this.getDeliveryUseCase.execute(request.deliveryId)) };
  }

  async listMessageTemplates(): Promise<notificationV1.ListMessageTemplatesResponse> {
    return { templates: this.listTemplates.execute().map(presentTemplate) };
  }
}
