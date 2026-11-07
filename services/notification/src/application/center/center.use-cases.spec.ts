import { type AppError, runWithContext, type UserContext } from '@ksp/platform';
import {
  FixedClock,
  InMemoryDeliveryHistory,
  InMemoryInAppNotifications,
  InMemoryPreferences,
} from '../testing/fakes';
import { type DeliveryRecord, type StoredInAppNotification } from './center.ports';
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
} from './center.use-cases';

const NOW = new Date('2026-11-07T10:00:00Z');
const ME = '0192f1c4-0000-7000-8000-00000000c001';
const OTHER = '0192f1c4-0000-7000-8000-00000000c002';
const id = (n: number) => `0192f1c4-7a2b-7c3d-8e4f-${String(n).padStart(12, '0')}`;

const customer: UserContext = {
  userId: ME,
  sessionId: 's',
  activeContext: 'personal',
  roles: [{ role: 'customer', scopeType: 'personal' }],
  mfa: false,
};
const staff = (role: string, mfa = true): UserContext => ({
  userId: OTHER,
  sessionId: 's',
  activeContext: 'personal',
  roles: [{ role, scopeType: 'global' }],
  mfa,
  authTime: NOW.getTime() / 1000 - 60,
});
const as = <T>(user: UserContext | undefined, fn: () => T): T =>
  runWithContext({ correlationId: 'c-test', ...(user ? { user } : {}) }, fn);
const code = (run: () => unknown) =>
  Promise.resolve()
    .then(run)
    .then(
      () => 'ok',
      (error: AppError) => error.code,
    );

const notification = (n: number, userId: string, readAt: Date | null = null): StoredInAppNotification => ({
  id: id(n),
  userId,
  templateCode: 'cleaning.quote_sent.customer',
  title: `Message ${n}`,
  body: 'Bonjour Koffi,',
  link: 'https://ksp.bj/mon-espace/nettoyage/demandes/x',
  createdAt: new Date(NOW.getTime() - (100 - n) * 60_000),
  readAt,
});

describe('centre de notifications de l’espace KSP', () => {
  function world() {
    const store = new InMemoryInAppNotifications();
    store.rows.push(
      notification(1, ME),
      notification(2, ME, new Date('2026-11-01T00:00:00Z')),
      notification(3, ME),
      notification(4, OTHER),
    );
    const clock = new FixedClock(NOW);
    return {
      store,
      list: new ListMyNotificationsUseCase(store),
      count: new CountMyUnreadNotificationsUseCase(store),
      markOne: new MarkNotificationReadUseCase(store, clock),
      markAll: new MarkAllNotificationsReadUseCase(store, clock),
    };
  }

  it('liste les seules notifications du compte, les plus récentes d’abord, avec le nombre de non lues', async () => {
    const { list } = world();
    const page = await as(customer, () => list.execute({ page: { limit: 2 }, unreadOnly: false }));
    expect(page.items.map((item) => item.id)).toEqual([id(3), id(2)]);
    expect(page.nextCursor).toBe(id(2));
    expect(page.unreadCount).toBe(2);
    const next = await as(customer, () =>
      list.execute({ page: { limit: 2, cursor: id(2) }, unreadOnly: false }),
    );
    expect(next.items.map((item) => item.id)).toEqual([id(1)]);
    expect(next.nextCursor).toBeNull();
  });

  it('filtre des non lues ; refus sans utilisateur ou avec un curseur mal formé', async () => {
    const { list, count } = world();
    const unread = await as(customer, () => list.execute({ page: undefined, unreadOnly: true }));
    expect(unread.items.map((item) => item.id)).toEqual([id(3), id(1)]);
    await expect(as(customer, () => count.execute())).resolves.toBe(2);
    expect(await code(() => as(undefined, () => count.execute()))).toBe('AUTH_REQUIRED');
    expect(
      await code(() => as(customer, () => list.execute({ page: { cursor: 'abc' }, unreadOnly: false }))),
    ).toBe('NOTIFICATION_VALIDATION_FAILED');
  });

  it('marquer lue : idempotent, date de lecture gardée, notification d’un autre compte introuvable', async () => {
    const { markOne, store } = world();
    const first = await as(customer, () => markOne.execute(id(1)));
    expect(first.notification.readAt).toEqual(NOW);
    expect(first.unreadCount).toBe(1);
    const again = await as(customer, () => markOne.execute(id(2)));
    expect(again.notification.readAt).toEqual(new Date('2026-11-01T00:00:00Z'));
    expect(await code(() => as(customer, () => markOne.execute(id(4))))).toBe('NOTIFICATION_NOT_FOUND');
    expect(store.rows.find((row) => row.id === id(4))!.readAt).toBeNull();
    expect(await code(() => as(customer, () => markOne.execute('x')))).toBe('NOTIFICATION_VALIDATION_FAILED');
  });

  it('tout marquer lu : seulement le compte, nombre marqué rendu', async () => {
    const { markAll, store } = world();
    await expect(as(customer, () => markAll.execute())).resolves.toEqual({ marked: 2, unreadCount: 0 });
    expect(store.rows.find((row) => row.id === id(4))!.readAt).toBeNull();
    await expect(as(customer, () => markAll.execute())).resolves.toEqual({ marked: 0, unreadCount: 0 });
  });
});

describe('préférences de canaux (ADR-039)', () => {
  it('valeurs par défaut, puis choix enregistré et daté', async () => {
    const preferences = new InMemoryPreferences();
    const get = new GetMyNotificationPreferencesUseCase(preferences);
    const update = new UpdateMyNotificationPreferencesUseCase(preferences, new FixedClock(NOW));
    await expect(as(customer, () => get.execute())).resolves.toEqual({
      whatsapp: true,
      email: true,
      updatedAt: null,
    });
    await as(customer, () => update.execute({ whatsapp: false, email: true }));
    await expect(as(customer, () => get.execute())).resolves.toEqual({
      whatsapp: false,
      email: true,
      updatedAt: NOW,
    });
    expect([...preferences.rows.keys()]).toEqual([ME]);
  });
});

describe('back-office des notifications', () => {
  const delivery = (n: number, overrides: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
    id: id(n),
    templateCode: 'billing.invoice_issued.customer',
    requestedChannel: 'email',
    channelUsed: 'email',
    channelsTried: ['email'],
    targetMasked: 'k***@example.com',
    recipientUserId: ME,
    status: 'accepted',
    errorCode: null,
    failureReason: null,
    providerMessageId: 'brevo-1',
    createdAt: new Date(`2026-11-0${n}T12:00:00Z`),
    expiresAt: null,
    acceptedAt: new Date(`2026-11-0${n}T12:00:01Z`),
    failedAt: null,
    erased: false,
    ...overrides,
  });

  function world() {
    const history = new InMemoryDeliveryHistory();
    history.rows.push(
      delivery(1),
      delivery(2, {
        templateCode: 'cleaning.quote_requested.customer',
        requestedChannel: 'whatsapp',
        channelUsed: null,
        channelsTried: ['whatsapp', 'email'],
        status: 'failed',
        errorCode: 'NOTIFICATION_CHANNELS_EXHAUSTED',
        failureReason: 'provider_unavailable',
      }),
      delivery(3, { recipientUserId: OTHER }),
    );
    const clock = new FixedClock(NOW);
    return {
      history,
      list: new ListDeliveriesUseCase(history, clock, 'Africa/Porto-Novo'),
      get: new GetDeliveryUseCase(history, clock),
      templates: new ListMessageTemplatesUseCase(clock),
    };
  }

  it('filtres : canal essayé, statut, destinataire ; période à l’heure du Bénin, bornes incluses', async () => {
    const { list, history } = world();
    const failed = await as(staff('support_agent'), () =>
      list.execute({ page: undefined, filters: { channel: 'email', status: 'failed' } }),
    );
    expect(failed.items.map((item) => item.id)).toEqual([id(2)]);
    const mine = await as(staff('super_admin'), () =>
      list.execute({ page: undefined, filters: { recipientUserId: OTHER.toUpperCase() } }),
    );
    expect(mine.items.map((item) => item.id)).toEqual([id(3)]);
    await as(staff('super_admin'), () =>
      list.execute({ page: undefined, filters: { from: '2026-11-02', to: '2026-11-02' } }),
    );
    expect(history.queries.at(-1)).toMatchObject({
      from: new Date('2026-11-01T23:00:00Z'),
      to: new Date('2026-11-02T23:00:00Z'),
    });
  });

  it('refus : client, double authentification absente, filtre mal formé, envoi inconnu', async () => {
    const { list, get, templates } = world();
    const run = (user: UserContext, filters: Record<string, string>) =>
      code(() => as(user, () => list.execute({ page: undefined, filters })));
    expect(await run(customer, {})).toBe('AUTH_FORBIDDEN');
    expect(await run(staff('support_agent', false), {})).toBe('AUTH_MFA_REQUIRED');
    expect(await run(staff('cleaning_admin'), {})).toBe('AUTH_FORBIDDEN');
    expect(await run(staff('super_admin'), { channel: 'fax' })).toBe('NOTIFICATION_VALIDATION_FAILED');
    expect(await run(staff('super_admin'), { status: 'sent' })).toBe('NOTIFICATION_VALIDATION_FAILED');
    expect(await run(staff('super_admin'), { from: '2026-02-30' })).toBe('NOTIFICATION_VALIDATION_FAILED');
    expect(await run(staff('super_admin'), { from: '2026-11-05', to: '2026-11-04' })).toBe(
      'NOTIFICATION_VALIDATION_FAILED',
    );
    expect(await run(staff('super_admin'), { templateCode: 'DROP TABLE' })).toBe(
      'NOTIFICATION_VALIDATION_FAILED',
    );
    expect(await code(() => as(staff('super_admin'), () => get.execute(id(9))))).toBe(
      'NOTIFICATION_NOT_FOUND',
    );
    expect(await code(() => as(customer, () => templates.execute()))).toBe('AUTH_FORBIDDEN');
  });

  it('détail d’un envoi : canaux essayés et cause d’échec, sans texte ni variables', async () => {
    const { get } = world();
    const detail = await as(staff('support_agent'), () => get.execute(id(2)));
    expect(detail).toMatchObject({
      channelsTried: ['whatsapp', 'email'],
      failureReason: 'provider_unavailable',
      targetMasked: 'k***@example.com',
    });
    expect(Object.keys(detail)).not.toContain('variables');
  });

  it('modèles : texte avec le nom des variables, codes secrets jamais rendus avec une valeur', async () => {
    const { templates } = world();
    const catalog = await as(staff('support_agent'), () => templates.execute());
    const codes = catalog.map((template) => template.code);
    expect(codes).toEqual([...codes].sort((a, b) => a.localeCompare(b)));
    const otp = catalog.find((template) => template.code === 'identity.otp')!;
    expect(otp).toMatchObject({ kind: 'direct', secret: true, optional: false, subject: null, text: null });
    const invoice = catalog.find((template) => template.code === 'billing.invoice_issued.customer')!;
    expect(invoice).toMatchObject({ kind: 'document', optional: true });
    expect(invoice.text).toContain('{invoice_number}');
    const verification = catalog.find((template) => template.code === 'identity.email_verification')!;
    expect(verification.text).toContain('{code}');
    const warning = catalog.find((template) => template.code === 'cleaning.suspension_warning.customer')!;
    expect(warning).toMatchObject({ kind: 'important', optional: false });
    const deletion = catalog.find(
      (template) => template.code === 'identity.account_deletion_requested.customer',
    )!;
    expect(deletion.optional).toBe(false);
    expect(catalog.filter((template) => template.code.endsWith('.agent')).every((t) => !t.optional)).toBe(
      true,
    );
  });
});
