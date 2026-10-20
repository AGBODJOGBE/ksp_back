import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import {
  ChallengeAlreadyConsumedError,
  PhoneAlreadyRegisteredError,
  type PhoneLoginPlan,
} from '../src/application/session/session.ports';
import { PrismaLoginRepository } from '../src/infrastructure/session/prisma-login.repository';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

/**
 * Test d'intégration contre un vrai PostgreSQL : la transaction d'ouverture de session.
 * Ignoré si TEST_DATABASE_URL n'est pas défini (la CI le fournit).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const PHONE = '+2290197000045';

describeWithDatabase('PrismaLoginRepository (PostgreSQL)', () => {
  const schema = `identity_login_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;
  let repository: PrismaLoginRepository;
  let seq = 0;
  const uuid = () => `0192f1c4-7a2b-7c3d-8e4f-${String(++seq).padStart(12, '0')}`;
  const base = new Date('2026-10-19T12:00:00Z');
  const at = (minutes: number) => new Date(base.getTime() + minutes * 60_000);

  async function sentChallenge(): Promise<string> {
    const id = uuid();
    await pool.query(
      `INSERT INTO otp_challenges (id, target, channel, purpose, code_hash, expires_at, sent_at)
       VALUES ($1, $2, 'whatsapp', 'login', 'h', $3, $4)`,
      [id, PHONE, at(60), base],
    );
    return id;
  }

  function plan(
    challengeId: string,
    existingUserId: string | null,
    now: Date,
    maxSessions = 5,
  ): PhoneLoginPlan {
    return {
      challengeId,
      phoneE164: PHONE,
      existingUserId,
      newUserId: uuid(),
      newPhoneId: uuid(),
      session: {
        id: uuid(),
        clientKind: 'mobile',
        deviceLabel: 'Téléphone Android',
        userAgent: 'KSP/1.0',
        ip: '196.192.10.4',
        expiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
      },
      refreshToken: { id: uuid(), hash: `empreinte-${seq}` },
      loginEventId: uuid(),
      maxSessions,
      now,
    };
  }

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
    repository = new PrismaLoginRepository(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE otp_challenges, users, outbox, login_events CASCADE');
  });

  it('crée le compte, sa session et son jeton, et publie identity.user.registered', async () => {
    const { account, isNewUser } = await repository.completePhoneLogin(
      plan(await sentChallenge(), null, base),
    );
    expect(isNewUser).toBe(true);
    expect(account).toMatchObject({ status: 'active', phoneE164: PHONE, firstName: null });
    expect(await repository.findByPhone(PHONE)).toEqual(account);

    const sessions = await pool.query('SELECT user_id, client_kind, revoked_at FROM sessions');
    expect(sessions.rows).toEqual([{ user_id: account.id, client_kind: 'mobile', revoked_at: null }]);
    expect((await pool.query('SELECT count(*)::int AS n FROM refresh_tokens')).rows[0].n).toBe(1);
    expect((await pool.query('SELECT success FROM login_events')).rows).toEqual([{ success: true }]);
    const outbox = await pool.query('SELECT event_type, payload FROM outbox');
    expect(outbox.rows.map((row) => row.event_type)).toEqual(['identity.user.registered']);
    expect(outbox.rows[0].payload.payload).toEqual({ userId: account.id, method: 'phone' });
  });

  it('une demande ne peut servir qu’une fois', async () => {
    const challenge = await sentChallenge();
    await repository.completePhoneLogin(plan(challenge, null, base));
    const existing = await repository.findByPhone(PHONE);
    await expect(repository.completePhoneLogin(plan(challenge, existing!.id, base))).rejects.toBeInstanceOf(
      ChallengeAlreadyConsumedError,
    );
  });

  it('un compte existant ne publie pas de second identity.user.registered', async () => {
    const { account } = await repository.completePhoneLogin(plan(await sentChallenge(), null, base));
    const again = await repository.completePhoneLogin(plan(await sentChallenge(), account.id, at(1)));
    expect(again.isNewUser).toBe(false);
    expect((await pool.query('SELECT count(*)::int AS n FROM outbox')).rows[0].n).toBe(1);
  });

  it('révoque la session la moins récemment utilisée au-delà de la limite', async () => {
    const { account } = await repository.completePhoneLogin(plan(await sentChallenge(), null, base, 2));
    await repository.completePhoneLogin(plan(await sentChallenge(), account.id, at(1), 2));
    await repository.completePhoneLogin(plan(await sentChallenge(), account.id, at(2), 2));
    const sessions = await pool.query('SELECT revoke_reason FROM sessions ORDER BY last_seen_at');
    expect(sessions.rows.map((row) => row.revoke_reason)).toEqual(['session_limit', null, null]);
  });

  it('deux créations simultanées du même numéro : la seconde est signalée, sans rien écrire', async () => {
    await repository.completePhoneLogin(plan(await sentChallenge(), null, base));
    const second = await sentChallenge();
    await expect(repository.completePhoneLogin(plan(second, null, base))).rejects.toBeInstanceOf(
      PhoneAlreadyRegisteredError,
    );
    const consumed = await pool.query('SELECT consumed_at FROM otp_challenges WHERE id = $1', [second]);
    expect(consumed.rows).toEqual([{ consumed_at: null }]);
  });

  it('lit un compte par son identifiant et met à jour seulement les champs donnés', async () => {
    const { account } = await repository.completePhoneLogin(plan(await sentChallenge(), null, base));
    expect(await repository.findById(account.id)).toEqual(account);
    expect(await repository.findById('0192f1c4-7a2b-7c3d-8e4f-ffffffffffff')).toBeNull();

    const named = await repository.updateProfile(account.id, { firstName: 'Koffi', lastName: 'Adjovi' });
    expect(named).toMatchObject({ firstName: 'Koffi', lastName: 'Adjovi', preferredLanguage: 'fr' });
    const english = await repository.updateProfile(account.id, { preferredLanguage: 'en' });
    expect(english).toMatchObject({ firstName: 'Koffi', lastName: 'Adjovi', preferredLanguage: 'en' });
    expect(
      await repository.updateProfile('0192f1c4-7a2b-7c3d-8e4f-ffffffffffff', { firstName: 'X' }),
    ).toBeNull();
  });

  it('enregistre un échec de connexion', async () => {
    await repository.recordFailedLogin({
      id: uuid(),
      userId: null,
      reason: 'otp_invalid',
      ip: null,
      userAgent: null,
    });
    const events = await pool.query('SELECT success, failure_reason FROM login_events');
    expect(events.rows).toEqual([{ success: false, failure_reason: 'otp_invalid' }]);
  });
});
