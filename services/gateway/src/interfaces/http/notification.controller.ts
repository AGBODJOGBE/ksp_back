import { Body, Controller, Inject, Param, Query } from '@nestjs/common';
import { type NotificationApi } from '../../application/notification/notification.ports';
import { NOTIFICATION_API } from '../../tokens';
import { idFrom, pageFrom } from './cleaning.controller';
import { parseParam } from './cleaning-schemas';
import { notificationParams } from './notification-schemas';
import { Route } from './route.decorator';
import { parseBody, requestBodies } from './schemas';

type Query = Record<string, unknown>;

/**
 * Routes /api/v1/notification/* (espace KSP) et /api/v1/admin/notification/* (back-office) du
 * centre de notifications (ADR-039). Rôles et double authentification contrôlés par le garde
 * d'après le manifeste, puis revérifiés par notification.
 */
@Controller()
export class NotificationHttpController {
  constructor(@Inject(NOTIFICATION_API) private readonly notifications: NotificationApi) {}

  @Route('listMyNotifications')
  listMine(@Query() query: Query) {
    const unread = parseParam(notificationParams.unread, query['unread'], 'unread');
    return this.notifications.listMine(pageFrom(query), unread === 'true');
  }

  @Route('countMyUnreadNotifications')
  countUnread() {
    return this.notifications.countUnread();
  }

  @Route('markNotificationRead')
  markRead(@Param('id') id: unknown) {
    return this.notifications.markRead(idFrom(id));
  }

  @Route('markAllNotificationsRead')
  markAllRead() {
    return this.notifications.markAllRead();
  }

  @Route('getMyNotificationPreferences')
  getPreferences() {
    return this.notifications.getPreferences();
  }

  @Route('updateMyNotificationPreferences')
  updatePreferences(@Body() body: unknown) {
    return this.notifications.updatePreferences(
      parseBody(requestBodies.updateMyNotificationPreferences, body),
    );
  }

  @Route('listNotificationDeliveries')
  listDeliveries(@Query() query: Query) {
    const filters = {
      templateCode: parseParam(notificationParams.templateCode, query['templateCode'], 'templateCode'),
      channel: parseParam(notificationParams.channel, query['channel'], 'channel'),
      status: parseParam(notificationParams.status, query['status'], 'status'),
      from: parseParam(notificationParams.optionalDate, query['from'], 'from'),
      to: parseParam(notificationParams.optionalDate, query['to'], 'to'),
      recipientUserId: parseParam(notificationParams.optionalId, query['recipientUserId'], 'recipientUserId'),
    };
    return this.notifications.listDeliveries(pageFrom(query), filters);
  }

  @Route('getNotificationDelivery')
  getDelivery(@Param('id') id: unknown) {
    return this.notifications.getDelivery(idFrom(id));
  }

  @Route('listNotificationTemplates')
  listTemplates() {
    return this.notifications.listTemplates();
  }
}
