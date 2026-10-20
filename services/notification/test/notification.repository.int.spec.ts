import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { type NewNotification } from '../src/application/send/notification.ports';
import { SendNotificationUseCase } from '../src/application/send/send-notification.use-case';
import { FakeProvider, FixedClock, SequentialIds } from '../src/application/testing/fakes';
import { PrismaNotificationRepository } from '../src/infrastructure/notification/prisma-notification.repository';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

/**
 * Test d'intégration contre un vrai PostgreSQL : applique les migrations du service dans un schéma
 * jetable, puis vérifie le dépôt des notifications, l'idempotence et l'écriture dans l'outbox.
 * Ignoré si TEST_DATABASE_URL n'est pas défini (la CI le fournit).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const NOW = new Date('2026-10-20T12:00:00Z');
const USER_ID = '0192f1c4-0000-7000-8000-000000000001';

describeWithDatabase('PrismaNotificationRepository (PostgreSQL)', () => {
  const schema = `notification_test_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;
  let repository: PrismaNotificationRepository;
  let seq = 0;

  const notification = (idempotencyKey: string): NewNotification => ({
    id: `0192f1c4-7a2b-7c3d-8e4f-${String(++seq).padStart(12, '0')}`,
    idempotencyKey,
    templateCode: 'identity.otp',
    requestedChannel: 'whatsapp',
    targetMasked: '+229********45',
    recipientUserId: null,
    createdAt: NOW,
    expiresAt: new Date('2026-10-20T12:05:00Z'),
  });

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
    repository = new PrismaNotificationRepository(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE notifications, outbox');
  });

  it('enregistre une notification en attente, sans aucune colonne pour le texte ou les variables', async () => {
    await expect(repository.claim(notification('challenge-1'))).resolves.toEqual({ created: true });
    const { rows } = await pool.query(
      'SELECT idempotency_key, template_code, requested_channel, status, target_masked, expires_at FROM notifications',
    );
    expect(rows).toEqual([
      {
        idempotency_key: 'challenge-1',
        template_code: 'identity.otp',
        requested_channel: 'whatsapp',
        status: 'pending',
        target_masked: '+229********45',
        expires_at: new Date('2026-10-20T12:05:00Z'),
      },
    ]);
    const columns = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'notifications'",
      [schema],
    );
    const names = columns.rows.map((row: { column_name: string }) => row.column_name);
    for (const forbidden of ['variables', 'body', 'text', 'code', 'phone_e164'])
      expect(names).not.toContain(forbidden);
  });

  it('une clé déjà vue renvoie la notification existante', async () => {
    const first = notification('challenge-1');
    await repository.claim(first);
    await repository.markAccepted(first.id, {
      channelUsed: 'whatsapp',
      channelsTried: ['whatsapp'],
      providerMessageId: 'wamid.1',
      at: NOW,
    });
    await expect(repository.claim(notification('challenge-1'))).resolves.toEqual({
      created: false,
      existing: {
        id: first.id,
        status: 'accepted',
        channelUsed: 'whatsapp',
        channelsTried: ['whatsapp'],
        errorCode: null,
      },
    });
    const { rows } = await pool.query('SELECT provider_message_id, accepted_at FROM notifications');
    expect(rows).toEqual([{ provider_message_id: 'wamid.1', accepted_at: NOW }]);
  });

  it('deux appels simultanés avec la même clé : un seul enregistrement', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => repository.claim(notification('challenge-concurrent'))),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM notifications');
    expect(rows).toEqual([{ n: 1 }]);
  });

  it('échec : statut et événement notification.message.failed dans la même transaction', async () => {
    const created = notification('challenge-1');
    await repository.claim(created);
    await repository.markFailed(
      created.id,
      {
        channelsTried: ['whatsapp', 'sms'],
        reason: 'provider_unavailable',
        errorCode: 'NOTIFICATION_CHANNELS_EXHAUSTED',
        at: NOW,
      },
      {
        notificationId: created.id,
        templateCode: 'identity.otp',
        channelsTried: ['whatsapp', 'sms'],
        reason: 'provider_unavailable',
        recipientUserId: USER_ID,
        targetMasked: '+229********45',
      },
    );

    const { rows } = await pool.query(
      'SELECT status, channels_tried::text[] AS channels_tried, error_code, failure_reason, failed_at FROM notifications',
    );
    expect(rows).toEqual([
      {
        status: 'failed',
        channels_tried: ['whatsapp', 'sms'],
        error_code: 'NOTIFICATION_CHANNELS_EXHAUSTED',
        failure_reason: 'provider_unavailable',
        failed_at: NOW,
      },
    ]);
    const outbox = await pool.query('SELECT event_type, payload FROM outbox');
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].event_type).toBe('notification.message.failed');
    expect(outbox.rows[0].payload).toMatchObject({ producer: 'notification', version: 1 });
    expect(outbox.rows[0].payload.payload).toEqual({
      notificationId: created.id,
      templateCode: 'identity.otp',
      channelsTried: ['whatsapp', 'sms'],
      reason: 'provider_unavailable',
      recipientUserId: USER_ID,
      targetMasked: '+229********45',
    });
  });

  it('cas d’usage sur la vraie base : deux appels, un seul envoi, aucun code en base', async () => {
    const whatsapp = new FakeProvider('whatsapp');
    const useCase = new SendNotificationUseCase(
      repository,
      [whatsapp],
      new FixedClock(NOW),
      new SequentialIds(),
    );
    const input = {
      callerService: 'identity',
      templateCode: 'identity.otp',
      channel: 'whatsapp' as const,
      fallbackChannels: ['sms' as const],
      recipient: { userId: '', phoneE164: '+2290197000045' },
      variables: { code: '482913', expires_in_minutes: '5' },
      idempotencyKey: 'challenge-usecase',
      locale: 'fr',
      ttlSeconds: 300,
    };
    const first = await useCase.execute(input);
    await expect(useCase.execute(input)).resolves.toEqual(first);
    expect(whatsapp.sent).toHaveLength(1);

    const dump = await pool.query('SELECT row_to_json(n)::text AS row FROM notifications n');
    expect(dump.rows).toHaveLength(1);
    expect(dump.rows[0].row).not.toContain('482913');
    expect(dump.rows[0].row).not.toContain('0197000045');
  });
});
