import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { type InAppNotification } from '../src/application/events/event-notification.ports';
import { PrismaEventInbox } from '../src/infrastructure/events/prisma-event-inbox';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

/**
 * Test d'intégration contre un vrai PostgreSQL : inbox des événements (processed_events) et
 * notifications dans l'espace (migration 0003), écrites dans la même transaction.
 * Ignoré si TEST_DATABASE_URL n'est pas défini (la CI le fournit).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const EVENT_ID = '0192f1c4-aaaa-7000-8000-000000000001';
const USER_ID = '0192f1c4-0000-7000-8000-000000000001';

const inApp = (id: string, overrides: Partial<InAppNotification> = {}): InAppNotification => ({
  id,
  userId: USER_ID,
  templateCode: 'cleaning.quote_sent.customer',
  title: 'Votre devis de nettoyage',
  body: 'Bonjour Koffi,\nVotre devis est prêt.',
  link: 'https://ksp.bj/mon-espace/nettoyage/demandes/r-1',
  sourceEventId: EVENT_ID,
  createdAt: new Date('2026-10-23T10:00:00Z'),
  ...overrides,
});

describeWithDatabase('PrismaEventInbox (PostgreSQL)', () => {
  const schema = `notification_inbox_test_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;
  let inbox: PrismaEventInbox;

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
    inbox = new PrismaEventInbox(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE processed_events, in_app_notifications');
  });

  it('marque l’événement traité et enregistre ses notifications dans l’espace', async () => {
    await expect(inbox.isProcessed(EVENT_ID)).resolves.toBe(false);
    await expect(inbox.complete(EVENT_ID, [inApp('0192f1c4-bbbb-7000-8000-000000000001')])).resolves.toBe(
      'processed',
    );
    await expect(inbox.isProcessed(EVENT_ID)).resolves.toBe(true);

    const { rows } = await pool.query(
      'SELECT user_id, template_code, title, body, link, source_event_id, read_at FROM in_app_notifications',
    );
    expect(rows).toEqual([
      {
        user_id: USER_ID,
        template_code: 'cleaning.quote_sent.customer',
        title: 'Votre devis de nettoyage',
        body: 'Bonjour Koffi,\nVotre devis est prêt.',
        link: 'https://ksp.bj/mon-espace/nettoyage/demandes/r-1',
        source_event_id: EVENT_ID,
        read_at: null,
      },
    ]);
  });

  it('un second traitement du même événement ne crée rien', async () => {
    await inbox.complete(EVENT_ID, [inApp('0192f1c4-bbbb-7000-8000-000000000001')]);
    await expect(inbox.complete(EVENT_ID, [inApp('0192f1c4-bbbb-7000-8000-000000000002')])).resolves.toBe(
      'duplicate',
    );
    const { rows } = await pool.query('SELECT count(*)::int AS count FROM in_app_notifications');
    expect(rows).toEqual([{ count: 1 }]);
  });

  it('deux traitements simultanés : un seul enregistre', async () => {
    const results = await Promise.all([
      inbox.complete(EVENT_ID, [inApp('0192f1c4-bbbb-7000-8000-000000000001')]),
      inbox.complete(EVENT_ID, [inApp('0192f1c4-bbbb-7000-8000-000000000002')]),
    ]);
    expect(results.sort()).toEqual(['duplicate', 'processed']);
    const { rows } = await pool.query('SELECT count(*)::int AS count FROM in_app_notifications');
    expect(rows).toEqual([{ count: 1 }]);
  });

  it('un événement sans destinataire joignable est tout de même marqué traité', async () => {
    await expect(inbox.complete(EVENT_ID, [])).resolves.toBe('processed');
    await expect(inbox.isProcessed(EVENT_ID)).resolves.toBe(true);
  });
});
