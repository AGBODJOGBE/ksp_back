import { type Metadata } from '@grpc/grpc-js';
import { type notificationV1 } from '@ksp/contracts';
import { AppError, type GrpcCaller } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { type Observable } from 'rxjs';
import { type Json, type Page } from '../../application/cleaning/cleaning.ports';
import {
  type DeliveryFilters,
  type NotificationApi,
} from '../../application/notification/notification.ports';
import { toUpstreamError } from './upstream-error';

export interface NotificationClients {
  center: notificationV1.InAppNotificationServiceClient;
  admin: notificationV1.NotificationAdminServiceClient;
}

/** Réponse de notification qui ne respecte pas le contrat : erreur interne, jamais transmise telle quelle. */
const malformed = (what: string) =>
  new AppError('INTERNAL', 'GATEWAY_UPSTREAM_ERROR', `Réponse de notification inattendue (${what}).`);
const orNull = (value: string | undefined): string | null => (value ? value : null);
const page = (value: Page): notificationV1.Page => ({ limit: value.limit ?? 0, cursor: value.cursor ?? '' });

export function presentInAppNotification(value: notificationV1.InAppNotification | undefined) {
  if (!value) throw malformed('notification');
  return {
    id: value.id,
    templateCode: value.templateCode,
    title: value.title,
    body: value.body,
    link: orNull(value.link),
    createdAt: value.createdAt,
    readAt: orNull(value.readAt),
  };
}

export function presentPreferences(value: notificationV1.NotificationPreferences | undefined) {
  if (!value) throw malformed('préférences');
  return { whatsapp: value.whatsapp, email: value.email, updatedAt: orNull(value.updatedAt) };
}

export function presentDelivery(value: notificationV1.Delivery | undefined) {
  if (!value) throw malformed('envoi');
  return {
    id: value.id,
    templateCode: value.templateCode,
    requestedChannel: value.requestedChannel,
    channelUsed: orNull(value.channelUsed),
    channelsTried: [...value.channelsTried],
    targetMasked: orNull(value.targetMasked),
    recipientUserId: orNull(value.recipientUserId),
    status: value.status,
    errorCode: orNull(value.errorCode),
    failureReason: orNull(value.failureReason),
    providerMessageId: orNull(value.providerMessageId),
    createdAt: value.createdAt,
    expiresAt: orNull(value.expiresAt),
    acceptedAt: orNull(value.acceptedAt),
    failedAt: orNull(value.failedAt),
    erased: value.erased,
  };
}

export function presentTemplate(value: notificationV1.MessageTemplate) {
  return {
    code: value.code,
    kind: value.kind,
    channels: [...value.channels],
    secret: value.secret,
    optional: value.optional,
    variables: [...value.variables],
    optionalVariables: [...value.optionalVariables],
    subject: orNull(value.subject),
    text: orNull(value.text),
  };
}

/**
 * Client gRPC de notification : délai, coupe-circuit et jeton de service par GrpcCaller. Seules
 * les lectures sont rejouées ; marquer lu et les préférences ne le sont jamais.
 */
export class NotificationGrpcAdapter implements NotificationApi {
  private readonly logger = new Logger('NotificationGrpc');

  constructor(
    private readonly clients: NotificationClients,
    private readonly caller: GrpcCaller,
  ) {}

  async listMine(value: Page, unreadOnly: boolean): Promise<Json> {
    const res = await this.read('listMyNotifications', (m) =>
      this.clients.center.listMyNotifications({ page: page(value), unreadOnly }, m),
    );
    return {
      data: res.notifications.map(presentInAppNotification),
      nextCursor: res.nextCursor || null,
      unreadCount: res.unreadCount,
    };
  }

  async countUnread(): Promise<Json> {
    const res = await this.read('countMyUnreadNotifications', (m) =>
      this.clients.center.countMyUnreadNotifications({}, m),
    );
    return { unreadCount: res.unreadCount };
  }

  async markRead(id: string): Promise<Json> {
    const res = await this.write('markNotificationRead', (m) =>
      this.clients.center.markNotificationRead({ notificationId: id }, m),
    );
    return { notification: presentInAppNotification(res.notification), unreadCount: res.unreadCount };
  }

  async markAllRead(): Promise<Json> {
    const res = await this.write('markAllNotificationsRead', (m) =>
      this.clients.center.markAllNotificationsRead({}, m),
    );
    return { marked: res.marked, unreadCount: res.unreadCount };
  }

  async getPreferences(): Promise<Json> {
    const res = await this.read('getMyNotificationPreferences', (m) =>
      this.clients.center.getMyNotificationPreferences({}, m),
    );
    return presentPreferences(res.preferences);
  }

  async updatePreferences(input: { whatsapp: boolean; email: boolean }): Promise<Json> {
    const res = await this.write('updateMyNotificationPreferences', (m) =>
      this.clients.center.updateMyNotificationPreferences(input, m),
    );
    return presentPreferences(res.preferences);
  }

  async listDeliveries(value: Page, filters: DeliveryFilters): Promise<Json> {
    const res = await this.read('listDeliveries', (m) =>
      this.clients.admin.listDeliveries(
        {
          page: page(value),
          templateCode: filters.templateCode ?? '',
          channel: filters.channel ?? '',
          status: filters.status ?? '',
          from: filters.from ?? '',
          to: filters.to ?? '',
          recipientUserId: filters.recipientUserId ?? '',
        },
        m,
      ),
    );
    return { data: res.deliveries.map(presentDelivery), nextCursor: res.nextCursor || null };
  }

  async getDelivery(id: string): Promise<Json> {
    const res = await this.read('getDelivery', (m) => this.clients.admin.getDelivery({ deliveryId: id }, m));
    return presentDelivery(res.delivery);
  }

  async listTemplates(): Promise<Json> {
    const res = await this.read('listMessageTemplates', (m) =>
      this.clients.admin.listMessageTemplates({}, m),
    );
    return { data: res.templates.map(presentTemplate) };
  }

  // --- Appels -----------------------------------------------------------------------------------

  private read<T>(name: string, invoke: (metadata: Metadata) => Observable<T>): Promise<T> {
    return this.call(name, invoke, { idempotent: true });
  }

  private write<T>(name: string, invoke: (metadata: Metadata) => Observable<T>): Promise<T> {
    return this.call(name, invoke, {});
  }

  private async call<T>(
    name: string,
    invoke: (metadata: Metadata) => Observable<T>,
    options: { idempotent?: boolean },
  ): Promise<T> {
    try {
      return await this.caller.call(name, invoke, options);
    } catch (error) {
      const upstream = toUpstreamError('notification', error);
      if (upstream.code !== (error as AppError)?.code) {
        this.logger.warn(
          `notification.${name} : ${(error as AppError)?.code ?? 'erreur'} → ${upstream.code}`,
        );
      }
      throw upstream;
    }
  }
}
