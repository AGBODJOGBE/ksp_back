import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AppError, ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import {
  EnsureUserByPhoneUseCase,
  FindUserByPhoneUseCase,
} from '../src/application/provisioning/phone-accounts.use-cases';
import { type PhoneLoginPlan } from '../src/application/session/session.ports';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { PrismaPendingAccountRepository } from '../src/infrastructure/provisioning/prisma-pending-account.repository';
import { PrismaLoginRepository } from '../src/infrastructure/session/prisma-login.repository';

/**
 * Test d'intégration contre un vrai PostgreSQL : compte d'un numéro lu ou créé pour cleaning
 * (FindUserByPhone, EnsureUserByPhone ; R-AG-02 du CDC Nettoyage v2), et première connexion par code
 * d'un compte « en attente de vérification ».
 * Ignoré si TEST_DATABASE_URL n'est pas défini (la CI le fournit).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const PHONE = '+2290197000045';
const ADMIN = '0192f1c4-7a2b-7c3d-8e4f-00000000ad01';

describeWithDatabase('compte d’un numéro pour un service (PostgreSQL)', () => {
  const schema = `identity_phone_accounts_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;
  let logins: PrismaLoginRepository;
  let find: FindUserByPhoneUseCase;
  let ensure: EnsureUserByPhoneUseCase;
  let seq = 0;
  const uuid = () => `0192f1c4-7a2b-7c3d-8e4f-${String(++seq).padStart(12, '0')}`;
  const now = new Date('2026-11-23T10:00:00Z');
  const input = { phone: PHONE, firstName: 'Awa', lastName: 'Dossou', requestedBy: ADMIN };

  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: AppError) => error,
    );
  const count = async (table: string) =>
    (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;

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
    logins = new PrismaLoginRepository(prisma);
    find = new FindUserByPhoneUseCase(logins);
    ensure = new EnsureUserByPhoneUseCase(
      logins,
      new PrismaPendingAccountRepository(prisma),
      { next: uuid },
      { now: () => now },
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE otp_challenges, users, outbox, login_events, audit_log CASCADE');
  });

  it('crée le compte en attente : numéro non vérifié, événement et trace, dans la même transaction', async () => {
    expect(await find.execute('cleaning', { phone: PHONE })).toEqual({ found: false });
    const created = await ensure.execute('cleaning', input);
    expect(created).toMatchObject({ status: 'pending_verification', created: true });

    const users = await pool.query('SELECT id, status, first_name, last_name FROM users');
    expect(users.rows).toEqual([
      { id: created.userId, status: 'pending_verification', first_name: 'Awa', last_name: 'Dossou' },
    ]);
    const phones = await pool.query('SELECT phone_e164, is_primary, verified_at FROM user_phones');
    expect(phones.rows).toEqual([{ phone_e164: PHONE, is_primary: true, verified_at: null }]);
    const outbox = await pool.query('SELECT event_type, payload FROM outbox');
    expect(outbox.rows.map((row) => row.event_type)).toEqual(['identity.user.registered']);
    // Comme à la première vérification : l'événement ne porte pas le téléphone.
    expect(outbox.rows[0].payload.payload).toEqual({ userId: created.userId, method: 'phone' });
    const audit = await pool.query('SELECT actor_id, action, entity_type, entity_id, details FROM audit_log');
    expect(audit.rows).toEqual([
      {
        actor_id: 'cleaning',
        action: 'user.registered_by_service',
        entity_type: 'user',
        entity_id: created.userId,
        details: { requestedBy: ADMIN },
      },
    ]);
  });

  it('trouve le compte créé, sous les deux formes du numéro, et le rend sans le recréer', async () => {
    const created = await ensure.execute('cleaning', input);
    for (const phone of [PHONE, '+22997000045', '+229 01 97 00 00 45']) {
      expect(await find.execute('cleaning', { phone })).toEqual({
        found: true,
        userId: created.userId,
        status: 'pending_verification',
      });
    }
    expect(await ensure.execute('cleaning', { ...input, firstName: 'Autre', phone: '+22997000045' })).toEqual(
      {
        userId: created.userId,
        status: 'pending_verification',
        created: false,
      },
    );
    expect(await count('users')).toBe(1);
    expect(await count('outbox')).toBe(1);
    expect((await pool.query('SELECT first_name FROM users')).rows).toEqual([{ first_name: 'Awa' }]);
  });

  it('refuse un appelant non autorisé, sans rien lire ni écrire', async () => {
    expect(await failure(find.execute('billing', { phone: PHONE }))).toMatchObject({
      kind: 'PERMISSION_DENIED',
      code: 'IDENTITY_CALLER_FORBIDDEN',
    });
    expect(await failure(ensure.execute('notification', input))).toMatchObject({
      code: 'IDENTITY_CALLER_FORBIDDEN',
    });
    expect(await count('users')).toBe(0);
    expect(await count('audit_log')).toBe(0);
  });

  it('deux appels simultanés pour le même numéro ne créent qu’un compte', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => ensure.execute('cleaning', input)));
    expect(new Set(results.map((result) => result.userId)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await count('users')).toBe(1);
    expect(await count('user_phones')).toBe(1);
    expect(await count('outbox')).toBe(1);
    expect(await count('audit_log')).toBe(1);
  });

  it.each(['suspended', 'deletion_pending', 'deleted'])(
    'compte %s : erreur dédiée, rien n’est créé',
    async (status) => {
      const created = await ensure.execute('cleaning', input);
      await pool.query(`UPDATE users SET status = $1::"UserStatus" WHERE id = $2`, [status, created.userId]);
      expect(await failure(ensure.execute('cleaning', input))).toMatchObject({
        kind: 'FAILED_PRECONDITION',
        code: 'IDENTITY_ACCOUNT_NOT_USABLE',
        details: { status },
      });
      expect(await count('users')).toBe(1);
      expect(await count('outbox')).toBe(1);
    },
  );

  describe('première connexion par code d’un compte en attente', () => {
    async function sentChallenge(): Promise<string> {
      const id = uuid();
      await pool.query(
        `INSERT INTO otp_challenges (id, target, channel, purpose, code_hash, expires_at, sent_at)
         VALUES ($1, $2, 'whatsapp', 'login', 'h', $3, $4)`,
        [id, PHONE, new Date(now.getTime() + 3_600_000), now],
      );
      return id;
    }
    const plan = (challengeId: string, existingUserId: string, at: Date): PhoneLoginPlan => ({
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
        expiresAt: new Date(at.getTime() + 30 * 24 * 3600 * 1000),
      },
      refreshToken: { id: uuid(), hash: `empreinte-${seq}` },
      loginEventId: uuid(),
      maxSessions: 5,
      now: at,
    });

    it('le compte devient actif, son téléphone est vérifié, identity.user.verified est publié une fois', async () => {
      const created = await ensure.execute('cleaning', input);
      const first = new Date(now.getTime() + 60_000);
      const { account, isNewUser } = await logins.completePhoneLogin(
        plan(await sentChallenge(), created.userId, first),
      );
      expect(isNewUser).toBe(false);
      expect(account).toMatchObject({
        id: created.userId,
        status: 'active',
        firstName: 'Awa',
        lastName: 'Dossou',
        phoneE164: PHONE,
      });
      const phones = await pool.query('SELECT verified_at FROM user_phones');
      expect(phones.rows).toEqual([{ verified_at: first }]);
      expect(await count('sessions')).toBe(1);
      const events = async () =>
        (await pool.query('SELECT event_type, payload FROM outbox ORDER BY created_at, event_type')).rows;
      expect((await events()).map((row) => row.event_type).sort()).toEqual([
        'identity.user.registered',
        'identity.user.verified',
      ]);
      const verified = (await events()).find((row) => row.event_type === 'identity.user.verified');
      expect(verified.payload.payload).toEqual({ userId: created.userId, verifiedVia: 'phone' });

      // Connexion suivante : compte déjà actif, aucun nouvel événement.
      await logins.completePhoneLogin(
        plan(await sentChallenge(), created.userId, new Date(first.getTime() + 60_000)),
      );
      expect(await events()).toHaveLength(2);
      expect(await ensure.execute('cleaning', input)).toEqual({
        userId: created.userId,
        status: 'active',
        created: false,
      });
    });

    it('un compte déjà actif n’est pas touché par sa connexion', async () => {
      const created = await ensure.execute('cleaning', input);
      await pool.query(`UPDATE users SET status = 'active' WHERE id = $1`, [created.userId]);
      await logins.completePhoneLogin(plan(await sentChallenge(), created.userId, now));
      expect((await pool.query('SELECT verified_at FROM user_phones')).rows).toEqual([{ verified_at: null }]);
      expect(await count('outbox')).toBe(1);
    });
  });
});
