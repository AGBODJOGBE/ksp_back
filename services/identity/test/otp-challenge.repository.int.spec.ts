import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { newOtpChallenge } from '../src/domain/otp/otp-challenge';
import { type OtpPolicy } from '../src/domain/otp/otp-policy';
import { PhoneNumber } from '../src/domain/user/phone-number';
import { PrismaOtpChallengeRepository } from '../src/infrastructure/otp/prisma-otp-challenge.repository';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

/**
 * Test d'intégration contre un vrai PostgreSQL : applique les migrations du service dans un schéma
 * jetable, puis vérifie le dépôt des demandes de code et l'écriture dans l'outbox.
 * Ignoré si TEST_DATABASE_URL n'est pas défini (la CI le fournit).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');

const policy: OtpPolicy = {
  codeLength: 6,
  ttlSeconds: 300,
  maxAttempts: 5,
  resendDelaySeconds: 60,
  maxPerHour: 5,
  maxPerDay: 10,
  blockSeconds: 3600,
};

const phone = PhoneNumber.parse('+2290197000045')!;
const other = PhoneNumber.parse('+33612345678')!;

describeWithDatabase('PrismaOtpChallengeRepository (PostgreSQL)', () => {
  const schema = `identity_test_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;
  let repository: PrismaOtpChallengeRepository;
  let seq = 0;

  const challenge = (target: PhoneNumber, now: Date) =>
    newOtpChallenge({
      id: `0192f1c4-7a2b-7c3d-8e4f-${String(++seq).padStart(12, '0')}`,
      target,
      channel: 'sms',
      purpose: 'login',
      codeHash: 'empreinte',
      ip: '196.192.10.4',
      now,
      policy,
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
    repository = new PrismaOtpChallengeRepository(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE otp_challenges, outbox');
  });

  it('enregistre une demande sans envoi : elle ne compte pas dans les limites', async () => {
    const now = new Date('2026-10-17T12:00:00Z');
    await repository.create(challenge(phone, now));
    const { rows } = await pool.query(
      'SELECT target, channel, purpose, attempts, expires_at, ip FROM otp_challenges',
    );
    expect(rows).toEqual([
      {
        target: '+2290197000045',
        channel: 'sms',
        purpose: 'login',
        attempts: 0,
        expires_at: new Date('2026-10-17T12:05:00Z'),
        ip: '196.192.10.4',
      },
    ]);
    expect(await repository.sentAtSince(phone, new Date(0))).toEqual([]);
  });

  it('marque l’envoi et écrit identity.otp.requested dans l’outbox, sans le code', async () => {
    const now = new Date('2026-10-17T12:00:00Z');
    const created = challenge(phone, now);
    await repository.create(created);
    await repository.markSent(created.id, 'whatsapp', now, {
      userId: null,
      purpose: 'login',
      channel: 'whatsapp',
      targetMasked: phone.masked(),
    });

    const { rows } = await pool.query('SELECT channel_used, sent_at FROM otp_challenges');
    expect(rows).toEqual([{ channel_used: 'whatsapp', sent_at: now }]);
    const outbox = await pool.query('SELECT event_type, payload FROM outbox');
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].event_type).toBe('identity.otp.requested');
    expect(outbox.rows[0].payload.payload).toEqual({
      userId: null,
      purpose: 'login',
      channel: 'whatsapp',
      targetMasked: '+229********45',
    });
  });

  it('ne compte que les envois réussis du numéro, depuis la date demandée', async () => {
    const base = new Date('2026-10-17T12:00:00Z');
    const at = (minutes: number) => new Date(base.getTime() + minutes * 60_000);
    const event = { userId: null, purpose: 'login' as const, channel: 'sms' as const, targetMasked: 'x' };

    const old = challenge(phone, at(0));
    const recent = challenge(phone, at(30));
    const failed = challenge(phone, at(40));
    const otherPhone = challenge(other, at(45));
    for (const c of [old, recent, failed, otherPhone]) await repository.create(c);
    await repository.markSent(old.id, 'sms', at(0), event);
    await repository.markSent(recent.id, 'sms', at(30), event);
    await repository.markSendFailed(failed.id, at(40));
    await repository.markSent(otherPhone.id, 'sms', at(45), event);

    expect(await repository.sentAtSince(phone, at(10))).toEqual([at(30)]);
    const failedRow = await pool.query('SELECT send_failed_at, sent_at FROM otp_challenges WHERE id = $1', [
      failed.id,
    ]);
    expect(failedRow.rows).toEqual([{ send_failed_at: at(40), sent_at: null }]);
  });
});
