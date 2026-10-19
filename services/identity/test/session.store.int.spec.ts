import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { PrismaLoginRepository } from '../src/infrastructure/session/prisma-login.repository';
import { PrismaSessionStore } from '../src/infrastructure/session/prisma-session.store';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

/**
 * Test d'intégration contre un vrai PostgreSQL : renouvellement et révocation des sessions.
 * Ignoré si TEST_DATABASE_URL n'est pas défini (la CI le fournit).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');

describeWithDatabase('PrismaSessionStore (PostgreSQL)', () => {
  const schema = `identity_sessions_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;
  let logins: PrismaLoginRepository;
  let store: PrismaSessionStore;
  let seq = 0;
  const uuid = () => `0192f1c4-7a2b-7c3d-8e4f-${String(++seq).padStart(12, '0')}`;
  const now = new Date('2026-10-19T12:00:00Z');
  const later = new Date('2026-10-19T13:00:00Z');

  /** Ouvre une session par la vraie transaction de connexion ; renvoie ses identifiants. */
  async function openSession(phone: string, existingUserId: string | null = null) {
    const challengeId = uuid();
    await pool.query(
      `INSERT INTO otp_challenges (id, target, channel, purpose, code_hash, expires_at, sent_at)
       VALUES ($1, $2, 'whatsapp', 'login', 'h', $3, $4)`,
      [challengeId, phone, later, now],
    );
    const sessionId = uuid();
    const tokenId = uuid();
    const hash = `empreinte-${tokenId}`;
    const { account } = await logins.completePhoneLogin({
      challengeId,
      phoneE164: phone,
      existingUserId,
      newUserId: uuid(),
      newPhoneId: uuid(),
      session: {
        id: sessionId,
        clientKind: 'web',
        deviceLabel: null,
        userAgent: null,
        ip: null,
        expiresAt: later,
      },
      refreshToken: { id: tokenId, hash },
      loginEventId: uuid(),
      maxSessions: 5,
      now,
    });
    return { userId: account.id, sessionId, tokenId, hash };
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
    logins = new PrismaLoginRepository(prisma);
    store = new PrismaSessionStore(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE otp_challenges, users, outbox, login_events CASCADE');
  });

  it('retrouve un jeton par son empreinte, avec sa session et son compte', async () => {
    const opened = await openSession('+2290197000045');
    const found = await store.findRefreshToken(opened.hash);
    expect(found).toMatchObject({
      id: opened.tokenId,
      usedAt: null,
      session: { id: opened.sessionId, clientKind: 'web', revokedAt: null },
      account: { id: opened.userId, phoneE164: '+2290197000045' },
    });
    expect(await store.findRefreshToken('inconnue')).toBeNull();
  });

  it('remplace le jeton et prolonge la session ; le même jeton ne passe qu’une fois', async () => {
    const opened = await openSession('+2290197000045');
    const rotation = (newId: string) => ({
      oldTokenId: opened.tokenId,
      newToken: { id: newId, hash: `empreinte-${newId}` },
      sessionId: opened.sessionId,
      sessionExpiresAt: new Date('2026-11-18T13:00:00Z'),
      now: later,
    });
    const results = await Promise.all([
      store.rotateRefreshToken(rotation(uuid())),
      store.rotateRefreshToken(rotation(uuid())),
    ]);
    expect(results.sort()).toEqual([false, true]);

    const old = await pool.query('SELECT used_at, replaced_by_id FROM refresh_tokens WHERE id = $1', [
      opened.tokenId,
    ]);
    expect(old.rows[0].used_at).toEqual(later);
    expect(old.rows[0].replaced_by_id).not.toBeNull();
    expect((await pool.query('SELECT count(*)::int AS n FROM refresh_tokens')).rows[0].n).toBe(2);
    const session = await pool.query('SELECT expires_at, last_seen_at FROM sessions WHERE id = $1', [
      opened.sessionId,
    ]);
    expect(session.rows[0]).toEqual({ expires_at: new Date('2026-11-18T13:00:00Z'), last_seen_at: later });
  });

  it('révoque une session de l’utilisateur, une seule fois, et jamais celle d’un autre', async () => {
    const a = await openSession('+2290197000045');
    const b = await openSession('+33612345678');
    expect(await store.revokeSession(a.sessionId, b.userId, 'logout', later)).toBe(0);
    expect(await store.revokeSession(a.sessionId, a.userId, 'logout', later)).toBe(1);
    expect(await store.revokeSession(a.sessionId, a.userId, 'logout', later)).toBe(0);
  });

  it('révoque toutes les sessions actives de l’utilisateur', async () => {
    const first = await openSession('+2290197000045');
    await openSession('+2290197000045', first.userId);
    expect(await store.revokeAllSessions(first.userId, 'logout_all_devices', later)).toBe(2);
    const reasons = await pool.query('SELECT DISTINCT revoke_reason FROM sessions');
    expect(reasons.rows).toEqual([{ revoke_reason: 'logout_all_devices' }]);
  });
});
