import { type NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  DELIVERY_ID,
  NOTIFICATION_ID,
  type NotificationServer,
  startNotificationStub,
} from './support/notification-stub';
import {
  type IdentityServer,
  ORIGINS,
  startGateway,
  startIdentityStub,
  TestKeys,
  USER_ID,
} from './support/harness';

/**
 * Ce que la gateway transmet à notification (centre de notifications, ADR-038) : utilisateur dans
 * le contexte, filtres, valeurs vides converties en null ; refus avant tout appel quand le rôle,
 * la double authentification ou un paramètre manquent.
 */
describe('gateway → notification', () => {
  const OTHER = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e99';
  let keys: TestKeys;
  let identity: IdentityServer;
  let notification: NotificationServer;
  let app: NestExpressApplication;
  let customer: string;
  let support: string;
  let supportWithoutMfa: string;
  let cleaningAdmin: string;

  beforeAll(async () => {
    keys = await TestKeys.create();
    identity = await startIdentityStub(keys);
    notification = await startNotificationStub(keys);
    app = await startGateway({ identityUrl: identity.url, notificationUrl: notification.url, keys });
    customer = await keys.accessToken();
    const staff = (role: string, mfa: boolean) =>
      keys.accessToken({ claims: { client_id: 'backoffice', mfa, roles: [{ role, scopeType: 'global' }] } });
    support = await staff('support_agent', true);
    supportWithoutMfa = await staff('support_agent', false);
    cleaningAdmin = await staff('cleaning_admin', true);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await identity?.close();
    await notification?.close();
  });

  beforeEach(() => notification.stub.reset());

  const http = () => request(app.getHttpServer());
  const web = (req: request.Test, token: string) =>
    req.set('Origin', ORIGINS.web).set('Authorization', `Bearer ${token}`);
  const backoffice = (req: request.Test, token: string) =>
    req.set('Origin', ORIGINS.backoffice).set('Authorization', `Bearer ${token}`);

  it('mes notifications : filtre des non lues et page transmis, lien vide → null', async () => {
    const res = await web(http().get('/api/v1/notification/notifications?unread=true&limit=5'), customer);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ unreadCount: 1, nextCursor: null });
    expect(res.body.data[0]).toMatchObject({ id: NOTIFICATION_ID, readAt: null });
    const call = notification.stub.last('listMyNotifications')!;
    expect(call.request).toMatchObject({ unreadOnly: true, page: { limit: 5, cursor: '' } });
    expect(call.context?.user?.userId).toBe(USER_ID);

    const count = await web(http().get('/api/v1/notification/notifications/unread-count'), customer);
    expect(count.body).toEqual({ unreadCount: 3 });
  });

  it('marquer lu, tout marquer lu, préférences', async () => {
    const read = await web(
      http().post(`/api/v1/notification/notifications/${NOTIFICATION_ID}/read`),
      customer,
    );
    expect(read.status).toBe(200);
    expect(read.body.notification.readAt).toBe('2026-11-07T10:00:00.000Z');
    expect(notification.stub.last('markNotificationRead')!.request).toEqual({
      notificationId: NOTIFICATION_ID,
    });

    const all = await web(http().post('/api/v1/notification/notifications/read-all'), customer);
    expect(all.body).toEqual({ marked: 2, unreadCount: 0 });

    const prefs = await web(http().get('/api/v1/notification/preferences'), customer);
    expect(prefs.body).toEqual({ whatsapp: true, email: true, updatedAt: null });
    const saved = await web(http().put('/api/v1/notification/preferences'), customer).send({
      whatsapp: false,
      email: true,
    });
    expect(saved.status).toBe(200);
    expect(notification.stub.last('updateMyNotificationPreferences')!.request).toEqual({
      whatsapp: false,
      email: true,
    });
  });

  it('back-office : filtres transmis, champs vides en null', async () => {
    const list = await backoffice(
      http().get(
        `/api/v1/admin/notification/deliveries?channel=email&status=failed&from=2026-11-01&to=2026-11-30&recipientUserId=${OTHER}`,
      ),
      support,
    );
    expect(list.status).toBe(200);
    expect(list.body.nextCursor).toBe(DELIVERY_ID);
    expect(list.body.data[0]).toMatchObject({ channelUsed: null, providerMessageId: null, expiresAt: null });
    expect(notification.stub.last('listDeliveries')!.request).toMatchObject({
      channel: 'email',
      status: 'failed',
      from: '2026-11-01',
      to: '2026-11-30',
      recipientUserId: OTHER,
      templateCode: '',
    });
    const detail = await backoffice(
      http().get(`/api/v1/admin/notification/deliveries/${DELIVERY_ID}`),
      support,
    );
    expect(detail.body.channelsTried).toEqual(['whatsapp', 'email']);
    const templates = await backoffice(http().get('/api/v1/admin/notification/templates'), support);
    expect(templates.body.data[0]).toMatchObject({ code: 'identity.otp', subject: null, text: null });
  });

  it('refus avant tout appel : rôle, double authentification, filtres et corps invalides', async () => {
    expect((await backoffice(http().get('/api/v1/admin/notification/deliveries'), customer)).status).toBe(
      403,
    );
    expect(
      (await backoffice(http().get('/api/v1/admin/notification/deliveries'), cleaningAdmin)).status,
    ).toBe(403);
    const noMfa = await backoffice(http().get('/api/v1/admin/notification/templates'), supportWithoutMfa);
    expect(noMfa.body.error.code).toBe('GATEWAY_MFA_REQUIRED');
    const badChannel = await backoffice(
      http().get('/api/v1/admin/notification/deliveries?channel=fax'),
      support,
    );
    expect(badChannel.status).toBe(400);
    const badDate = await backoffice(
      http().get('/api/v1/admin/notification/deliveries?from=01/11/2026'),
      support,
    );
    expect(badDate.status).toBe(400);
    const badUnread = await web(http().get('/api/v1/notification/notifications?unread=oui'), customer);
    expect(badUnread.status).toBe(400);
    const badBody = await web(http().put('/api/v1/notification/preferences'), customer).send({
      whatsapp: 'non',
      email: true,
    });
    expect(badBody.status).toBe(400);
    const unknownField = await web(http().put('/api/v1/notification/preferences'), customer).send({
      whatsapp: true,
      email: true,
      sms: true,
    });
    expect(unknownField.status).toBe(400);
    expect((await http().get('/api/v1/notification/notifications').set('Origin', ORIGINS.web)).status).toBe(
      401,
    );
    expect(notification.stub.calls).toEqual([]);
  });
});
