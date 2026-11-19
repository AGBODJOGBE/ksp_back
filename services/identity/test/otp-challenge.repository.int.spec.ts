import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { type OtpSender } from '../src/application/otp/otp.ports';
import { RequestOtpUseCase } from '../src/application/otp/request-otp.use-case';
import { type OtpChallenge, newOtpChallenge } from '../src/domain/otp/otp-challenge';
import { decideSend, type OtpPolicy } from '../src/domain/otp/otp-policy';
import { PhoneNumber } from '../src/domain/user/phone-number';
import { PrismaOtpChallengeRepository } from '../src/infrastructure/otp/prisma-otp-challenge.repository';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { UuidV7Generator } from '../src/infrastructure/system/system';

/**
 * Test d'intégration contre un vrai PostgreSQL : applique les migrations du service dans un schéma
 * jetable, puis vérifie le dépôt des demandes de code, l'écriture dans l'outbox et les limites
 * d'envoi sous des demandes simultanées (vérification et enregistrement atomiques).
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
const CONCURRENT = 20;
const allowAll = () => ({ allowed: true }) as const;
const codeOf = (error: unknown) => (error instanceof AppError ? error.code : String(error));

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
    // Plusieurs connexions : les demandes simultanées s'exécutent vraiment en parallèle.
    url.searchParams.set('connection_limit', '10');
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

  /** Enregistre une demande sans appliquer de limite ; renvoie les envois comptés à ce moment. */
  const insert = async (created: OtpChallenge, since = new Date(0)) =>
    (await repository.createIfAllowed(created, since, allowAll)).recent;

  it('enregistre une demande avant l’envoi', async () => {
    const now = new Date('2026-10-17T12:00:00Z');
    expect(await insert(challenge(phone, now))).toEqual([]);
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
  });

  it('refuse sans rien enregistrer quand la décision refuse', async () => {
    const now = new Date('2026-10-17T12:00:00Z');
    const reservation = await repository.createIfAllowed(challenge(phone, now), new Date(0), () => ({
      allowed: false,
      retryAfterSeconds: 42,
    }));
    expect(reservation).toEqual({ decision: { allowed: false, retryAfterSeconds: 42 }, recent: [] });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM otp_challenges');
    expect(rows[0].n).toBe(0);
  });

  it('marque l’envoi et écrit identity.otp.requested dans l’outbox, sans le code', async () => {
    const now = new Date('2026-10-17T12:00:00Z');
    const created = challenge(phone, now);
    await insert(created);
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

  it('compte les envois réussis et en cours du numéro depuis la date demandée, pas les échecs', async () => {
    const base = new Date('2026-10-17T12:00:00Z');
    const at = (minutes: number) => new Date(base.getTime() + minutes * 60_000);
    const event = { userId: null, purpose: 'login' as const, channel: 'sms' as const, targetMasked: 'x' };

    const old = challenge(phone, at(0));
    const recent = challenge(phone, at(30));
    const failed = challenge(phone, at(40));
    const pending = challenge(phone, at(42));
    const otherPhone = challenge(other, at(45));
    for (const c of [old, recent, failed, pending, otherPhone]) await insert(c);
    await repository.markSent(old.id, 'sms', at(0), event);
    await repository.markSent(recent.id, 'sms', at(31), event);
    await repository.markSendFailed(failed.id, at(40));
    await repository.markSent(otherPhone.id, 'sms', at(45), event);

    // Envoi réussi : date d'envoi ; envoi en cours : date de création.
    const counted = await insert(challenge(phone, at(50)), at(10));
    expect(counted.map((date) => date.getTime()).sort()).toEqual([at(31).getTime(), at(42).getTime()]);
    const failedRow = await pool.query('SELECT send_failed_at, sent_at FROM otp_challenges WHERE id = $1', [
      failed.id,
    ]);
    expect(failedRow.rows).toEqual([{ send_failed_at: at(40), sent_at: null }]);
  });

  describe('demandes simultanées pour le même numéro', () => {
    /** Envoi qui rend la main plus tard : les demandes simultanées se chevauchent vraiment. */
    const slowSender: OtpSender = {
      send: async ({ channel }) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { channelUsed: channel };
      },
    };

    const requestOtp = (otpPolicy: OtpPolicy) =>
      new RequestOtpUseCase(
        repository,
        slowSender,
        { hash: () => 'empreinte', matches: () => false },
        { generate: (length) => '4'.repeat(length) },
        new UuidV7Generator(),
        { now: () => new Date() },
        otpPolicy,
      );

    async function concurrently(otpPolicy: OtpPolicy) {
      const useCase = requestOtp(otpPolicy);
      const outcomes = await Promise.allSettled(
        Array.from({ length: CONCURRENT }, () =>
          useCase.execute({ phone: phone.e164, channel: 'sms', purpose: 'login', ip: null }),
        ),
      );
      const rejected = outcomes.flatMap((outcome) =>
        outcome.status === 'rejected' ? [codeOf(outcome.reason)] : [],
      );
      const { rows } = await pool.query(
        'SELECT count(*)::int AS n, count(sent_at)::int AS sent FROM otp_challenges WHERE target = $1',
        [phone.e164],
      );
      return { fulfilled: outcomes.length - rejected.length, rejected, rows: rows[0] };
    }

    it('n’envoient qu’un code pendant le délai entre deux envois', async () => {
      const { fulfilled, rejected, rows } = await concurrently(policy);

      expect(fulfilled).toBe(1);
      expect(rejected).toEqual(Array(CONCURRENT - 1).fill('IDENTITY_OTP_RATE_LIMITED'));
      expect(rows).toEqual({ n: 1, sent: 1 });
    });

    it('ne dépassent jamais le plafond horaire', async () => {
      const { fulfilled, rejected, rows } = await concurrently({ ...policy, resendDelaySeconds: 0 });

      expect(fulfilled).toBe(policy.maxPerHour);
      expect(rejected).toEqual(Array(CONCURRENT - policy.maxPerHour).fill('IDENTITY_OTP_RATE_LIMITED'));
      expect(rows).toEqual({ n: policy.maxPerHour, sent: policy.maxPerHour });
    });

    it('le verrou ne bloque pas un autre numéro', async () => {
      const at = new Date();
      const reservations = await Promise.all([
        repository.createIfAllowed(challenge(phone, at), new Date(0), (recent) =>
          decideSend(recent, at, policy),
        ),
        repository.createIfAllowed(challenge(other, at), new Date(0), (recent) =>
          decideSend(recent, at, policy),
        ),
      ]);
      expect(reservations.map((reservation) => reservation.decision.allowed)).toEqual([true, true]);
    });
  });
});
