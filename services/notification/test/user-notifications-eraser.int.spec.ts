import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { PrismaUserNotificationsEraser } from '../src/infrastructure/privacy/prisma-user-notifications-eraser';

/**
 * Test d'intégration contre un vrai PostgreSQL : effacement des données d'un compte anonymisé
 * (ADR-036) — notifications de l'espace, historique des envois et outbox — dans la même
 * transaction que l'inbox. Ignoré si TEST_DATABASE_URL n'est pas défini (la CI le fournit).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const USER_ID = '0192f1c4-0000-7000-8000-000000000001';
const OTHER_USER_ID = '0192f1c4-0000-7000-8000-000000000002';
const CONSUMER = 'notification.identity.user.deleted';
const EVENT_ID = '0192f1c4-aaaa-7000-8000-000000000001';

describeWithDatabase('PrismaUserNotificationsEraser (PostgreSQL)', () => {
  const schema = `notification_erasure_test_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;
  let eraser: PrismaUserNotificationsEraser;

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
    eraser = new PrismaUserNotificationsEraser(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  const inApp = (id: number, userId: string) =>
    pool.query(
      'INSERT INTO in_app_notifications (id, user_id, template_code, title, body, link, source_event_id, created_at) ' +
        "VALUES ($1, $2, 'cleaning.quote_sent.customer', 'Votre devis', 'Bonjour Koffi', NULL, $3, now())",
      // Une notification par événement source : (événement, compte, modèle) est unique.
      [
        `0192f1c4-bbbb-7000-8000-${String(id).padStart(12, '0')}`,
        userId,
        `0192f1c4-eeee-7000-8000-${String(id).padStart(12, '0')}`,
      ],
    );

  const delivery = (id: number, userId: string | null, status: 'accepted' | 'failed') =>
    pool.query(
      'INSERT INTO notifications (id, idempotency_key, template_code, requested_channel, channel_used, ' +
        'channels_tried, target_masked, recipient_user_id, status, provider_message_id, error_code, ' +
        'failure_reason, created_at, accepted_at, failed_at) ' +
        "VALUES ($1, $2, 'billing.invoice_issued.customer', 'email', $3, ARRAY['email']::\"NotificationChannel\"[], " +
        "'k***@exemple.com', $4, $5::\"NotificationStatus\", $6, $7, $8, '2026-10-20T12:00:00Z', $9, $10)",
      [
        `0192f1c4-cccc-7000-8000-${String(id).padStart(12, '0')}`,
        `${EVENT_ID}:billing.invoice_issued.customer:${userId ?? 'sans-compte'}:${id}`,
        status === 'accepted' ? 'email' : null,
        userId,
        status,
        status === 'accepted' ? `msg-${id}` : null,
        status === 'failed' ? 'NOTIFICATION_CHANNELS_EXHAUSTED' : null,
        status === 'failed' ? 'provider_rejected' : null,
        status === 'accepted' ? '2026-10-20T12:00:01Z' : null,
        status === 'failed' ? '2026-10-20T12:00:01Z' : null,
      ],
    );

  const failedEvent = (id: number, userId: string) =>
    pool.query(
      "INSERT INTO outbox (id, event_type, payload, created_at, published_at) VALUES ($1, 'notification.message.failed', $2, now(), now())",
      [
        `0192f1c4-dddd-7000-8000-${String(id).padStart(12, '0')}`,
        JSON.stringify({
          eventId: `0192f1c4-dddd-7000-8000-${String(id).padStart(12, '0')}`,
          type: 'notification.message.failed',
          payload: {
            notificationId: `0192f1c4-cccc-7000-8000-${String(id).padStart(12, '0')}`,
            templateCode: 'billing.invoice_issued.customer',
            channelsTried: ['email'],
            reason: 'provider_rejected',
            recipientUserId: userId,
            targetMasked: 'k***@exemple.com',
          },
        }),
      ],
    );

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE processed_events, in_app_notifications, notifications, outbox, notification_preferences',
    );
  });

  it('efface les notifications de l’espace, détache les envois et l’outbox, garde les statistiques', async () => {
    await inApp(1, USER_ID);
    await inApp(2, USER_ID);
    await inApp(3, OTHER_USER_ID);
    await delivery(1, USER_ID, 'accepted');
    await delivery(2, USER_ID, 'failed');
    await delivery(3, OTHER_USER_ID, 'accepted');
    await failedEvent(2, USER_ID);
    await failedEvent(4, OTHER_USER_ID);
    for (const userId of [USER_ID, OTHER_USER_ID]) {
      await pool.query(
        'INSERT INTO notification_preferences (user_id, whatsapp, email, updated_at) VALUES ($1, false, true, now())',
        [userId],
      );
    }

    await expect(eraser.eraseUser(USER_ID, { eventId: EVENT_ID, consumer: CONSUMER })).resolves.toEqual({
      status: 'processed',
      inApp: 2,
      deliveries: 2,
    });

    const { rows: remaining } = await pool.query('SELECT user_id FROM in_app_notifications');
    expect(remaining).toEqual([{ user_id: OTHER_USER_ID }]);
    const { rows: preferences } = await pool.query('SELECT user_id FROM notification_preferences');
    expect(preferences).toEqual([{ user_id: OTHER_USER_ID }]);

    const { rows: deliveries } = await pool.query(
      'SELECT id, idempotency_key, template_code, channel_used, channels_tried, target_masked, ' +
        'recipient_user_id, status, provider_message_id, error_code, failure_reason, accepted_at, failed_at ' +
        'FROM notifications ORDER BY id',
    );
    expect(deliveries).toEqual([
      expect.objectContaining({
        idempotency_key: `erased:${deliveries[0].id}`,
        template_code: 'billing.invoice_issued.customer',
        channel_used: 'email',
        channels_tried: '{email}',
        target_masked: '',
        recipient_user_id: null,
        status: 'accepted',
        provider_message_id: null,
        accepted_at: new Date('2026-10-20T12:00:01Z'),
      }),
      expect.objectContaining({
        idempotency_key: `erased:${deliveries[1].id}`,
        target_masked: '',
        recipient_user_id: null,
        status: 'failed',
        error_code: 'NOTIFICATION_CHANNELS_EXHAUSTED',
        failure_reason: 'provider_rejected',
        failed_at: new Date('2026-10-20T12:00:01Z'),
      }),
      expect.objectContaining({
        target_masked: 'k***@exemple.com',
        recipient_user_id: OTHER_USER_ID,
        provider_message_id: 'msg-3',
      }),
    ]);
    expect(JSON.stringify(deliveries.slice(0, 2))).not.toContain(USER_ID);

    const { rows: outbox } = await pool.query("SELECT payload->'payload' AS payload FROM outbox ORDER BY id");
    expect(outbox[0].payload).toEqual({
      notificationId: '0192f1c4-cccc-7000-8000-000000000002',
      templateCode: 'billing.invoice_issued.customer',
      channelsTried: ['email'],
      reason: 'provider_rejected',
      targetMasked: '',
    });
    expect(outbox[1].payload).toMatchObject({
      recipientUserId: OTHER_USER_ID,
      targetMasked: 'k***@exemple.com',
    });
  });

  it('idempotent : une seconde livraison du même événement n’efface rien', async () => {
    await eraser.eraseUser(USER_ID, { eventId: EVENT_ID, consumer: CONSUMER });
    await inApp(1, USER_ID);

    await expect(eraser.eraseUser(USER_ID, { eventId: EVENT_ID, consumer: CONSUMER })).resolves.toEqual({
      status: 'duplicate',
      inApp: 0,
      deliveries: 0,
    });
    const { rows } = await pool.query('SELECT count(*)::int AS count FROM in_app_notifications');
    expect(rows).toEqual([{ count: 1 }]);
  });

  it('compte sans notification : événement marqué traité, rien d’autre ne change', async () => {
    await inApp(1, OTHER_USER_ID);
    await delivery(1, OTHER_USER_ID, 'accepted');
    await delivery(2, null, 'accepted');

    await expect(eraser.eraseUser(USER_ID, { eventId: EVENT_ID, consumer: CONSUMER })).resolves.toEqual({
      status: 'processed',
      inApp: 0,
      deliveries: 0,
    });
    const { rows: processed } = await pool.query('SELECT event_id, consumer FROM processed_events');
    expect(processed).toEqual([{ event_id: EVENT_ID, consumer: CONSUMER }]);
    const { rows: deliveries } = await pool.query(
      "SELECT count(*)::int AS count FROM notifications WHERE target_masked = 'k***@exemple.com'",
    );
    expect(deliveries).toEqual([{ count: 2 }]);
  });
});
