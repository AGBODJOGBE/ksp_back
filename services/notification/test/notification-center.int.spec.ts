import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { PrismaDeliveryHistory } from '../src/infrastructure/center/prisma-delivery-history';
import { PrismaInAppNotifications } from '../src/infrastructure/center/prisma-in-app-notifications';
import { PrismaPreferences } from '../src/infrastructure/center/prisma-preferences';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

/**
 * Test d'intégration contre un vrai PostgreSQL : dépôts du centre de notifications (ADR-038) —
 * pagination par curseur, compte du propriétaire seul, préférences, filtres de l'historique.
 * Ignoré si TEST_DATABASE_URL n'est pas défini (la CI le fournit).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const ME = '0192f1c4-0000-7000-8000-000000000001';
const OTHER = '0192f1c4-0000-7000-8000-000000000002';
const id = (n: number) => `0192f1c4-cccc-7000-8000-${String(n).padStart(12, '0')}`;

describeWithDatabase('centre de notifications (PostgreSQL)', () => {
  const schema = `notification_center_test_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;

  beforeAll(async () => {
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    for (const migration of readdirSync(MIGRATIONS)
      .filter((name) => /^\d{4}_/.test(name))
      .sort()) {
      await pool.query(readFileSync(join(MIGRATIONS, migration, 'migration.sql'), 'utf8'));
    }
    const url = new URL(databaseUrl as string);
    url.searchParams.set('schema', schema);
    process.env.DATABASE_URL = url.toString();
    prisma = new PrismaService(new ReadinessRegistry());
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE in_app_notifications, notifications, notification_preferences');
  });

  const inApp = (n: number, userId: string, createdAt: string, readAt: string | null = null) =>
    pool.query(
      'INSERT INTO in_app_notifications (id, user_id, template_code, title, body, link, source_event_id, created_at, read_at) ' +
        "VALUES ($1, $2, 'cleaning.quote_sent.customer', 'Votre devis', 'Bonjour', NULL, $3, $4, $5)",
      [id(n), userId, id(100 + n), createdAt, readAt],
    );

  it('notifications : plus récentes d’abord, curseur stable à date égale, compte du propriétaire seul', async () => {
    const store = new PrismaInAppNotifications(prisma);
    await inApp(1, ME, '2026-11-01T10:00:00Z');
    await inApp(2, ME, '2026-11-02T10:00:00Z', '2026-11-03T10:00:00Z');
    await inApp(3, ME, '2026-11-02T10:00:00Z');
    await inApp(4, OTHER, '2026-11-04T10:00:00Z');

    const first = await store.list(ME, { limit: 2, cursor: null }, { unreadOnly: false });
    expect(first.items.map((item) => item.id)).toEqual([id(3), id(2)]);
    expect(first.nextCursor).toBe(id(2));
    const second = await store.list(ME, { limit: 2, cursor: id(2) }, { unreadOnly: false });
    expect(second.items.map((item) => item.id)).toEqual([id(1)]);
    expect(second.nextCursor).toBeNull();
    // Curseur d'un autre compte : rien.
    await expect(store.list(ME, { limit: 2, cursor: id(4) }, { unreadOnly: false })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    const unread = await store.list(ME, { limit: 10, cursor: null }, { unreadOnly: true });
    expect(unread.items.map((item) => item.id)).toEqual([id(3), id(1)]);
    await expect(store.countUnread(ME)).resolves.toBe(2);

    const at = new Date('2026-11-07T10:00:00Z');
    await expect(store.markRead(ME, id(4), at)).resolves.toBeNull();
    const read = await store.markRead(ME, id(2), at);
    expect(read!.readAt).toEqual(new Date('2026-11-03T10:00:00Z'));
    await expect(store.markAllRead(ME, at)).resolves.toBe(2);
    await expect(store.countUnread(ME)).resolves.toBe(0);
    await expect(store.countUnread(OTHER)).resolves.toBe(1);
  });

  it('préférences : valeurs par défaut, enregistrement, lecture groupée', async () => {
    const store = new PrismaPreferences(prisma);
    await expect(store.get(ME)).resolves.toEqual({ whatsapp: true, email: true, updatedAt: null });
    const at = new Date('2026-11-07T10:00:00Z');
    await store.save(ME, { whatsapp: false, email: true }, at);
    await store.save(ME, { whatsapp: false, email: false }, at);
    await expect(store.get(ME)).resolves.toEqual({ whatsapp: false, email: false, updatedAt: at });
    const many = await store.findMany([ME, OTHER]);
    expect([...many]).toEqual([[ME, { whatsapp: false, email: false }]]);
  });

  it('historique : filtres combinés, période, pagination, compte effacé signalé', async () => {
    const history = new PrismaDeliveryHistory(prisma);
    const delivery = (
      n: number,
      values: {
        key?: string;
        template?: string;
        tried: string;
        status: string;
        user: string | null;
        at: string;
      },
    ) =>
      pool.query(
        'INSERT INTO notifications (id, idempotency_key, template_code, requested_channel, channels_tried, ' +
          'target_masked, recipient_user_id, status, created_at) ' +
          'VALUES ($1, $2, $3, \'whatsapp\', $4::"NotificationChannel"[], \'+229********45\', $5, $6::"NotificationStatus", $7)',
        [
          id(n),
          values.key ?? `evt:${n}`,
          values.template ?? 'cleaning.quote_sent.customer',
          `{${values.tried}}`,
          values.user,
          values.status,
          values.at,
        ],
      );
    await delivery(1, { tried: 'whatsapp', status: 'accepted', user: ME, at: '2026-11-01T22:30:00Z' });
    await delivery(2, { tried: 'whatsapp,email', status: 'failed', user: ME, at: '2026-11-02T10:00:00Z' });
    await delivery(3, {
      key: `erased:${id(3)}`,
      template: 'billing.invoice_issued.customer',
      tried: 'email',
      status: 'accepted',
      user: null,
      at: '2026-11-03T10:00:00Z',
    });

    const email = await history.list(
      { templateCode: null, channel: 'email', status: null, from: null, to: null, recipientUserId: null },
      { limit: 1, cursor: null },
    );
    expect(email.items.map((item) => item.id)).toEqual([id(3)]);
    expect(email.items[0]!.erased).toBe(true);
    const next = await history.list(
      { templateCode: null, channel: 'email', status: null, from: null, to: null, recipientUserId: null },
      { limit: 1, cursor: email.nextCursor },
    );
    expect(next.items.map((item) => item.id)).toEqual([id(2)]);
    expect(next.nextCursor).toBeNull();

    // 2 novembre au Bénin : du 1er à 23 h UTC au 2 à 23 h UTC.
    const day = await history.list(
      {
        templateCode: null,
        channel: null,
        status: null,
        from: new Date('2026-11-01T23:00:00Z'),
        to: new Date('2026-11-02T23:00:00Z'),
        recipientUserId: ME,
      },
      { limit: 10, cursor: null },
    );
    expect(day.items.map((item) => item.id)).toEqual([id(2)]);
    const found = await history.find(id(2));
    expect(found).toMatchObject({ channelsTried: ['whatsapp', 'email'], status: 'failed', erased: false });
    expect(found).not.toHaveProperty('idempotencyKey');
  });
});
