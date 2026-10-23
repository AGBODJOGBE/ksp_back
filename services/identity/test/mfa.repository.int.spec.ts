import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import {
  MfaChallengeAlreadyConsumedError,
  type MfaLoginPlan,
  RecoveryCodeAlreadyUsedError,
  type SecondFactorProof,
  TotpAlreadyEnabledError,
  TotpStepAlreadyUsedError,
} from '../src/application/mfa/mfa.ports';
import { ChallengeAlreadyConsumedError } from '../src/application/session/session.ports';
import { INITIAL_BACKOFFICE_ROLES } from '../src/domain/role/role';
import { PrismaMfaRepository } from '../src/infrastructure/mfa/prisma-mfa.repository';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { PrismaRoleRepository } from '../src/infrastructure/role/prisma-role.repository';
import { PrismaSessionStore } from '../src/infrastructure/session/prisma-session.store';

/**
 * Test d'intégration contre un vrai PostgreSQL : rôles (migration 0004) et double authentification.
 * Ignoré si TEST_DATABASE_URL n'est pas défini (la CI le fournit).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');

describeWithDatabase('Rôles et double authentification (PostgreSQL)', () => {
  const schema = `identity_mfa_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;
  let roles: PrismaRoleRepository;
  let mfa: PrismaMfaRepository;
  let sessions: PrismaSessionStore;
  let seq = 0;
  const uuid = () => `0192f1c4-7a2b-7c3d-8e4f-${String(++seq).padStart(12, '0')}`;
  const base = new Date('2026-10-22T09:00:00Z');
  const at = (minutes: number) => new Date(base.getTime() + minutes * 60_000);

  async function user(phone = `+22901970${String(++seq).padStart(5, '0')}`): Promise<string> {
    const id = uuid();
    await pool.query(`INSERT INTO users (id, status, updated_at) VALUES ($1, 'active', now())`, [id]);
    await pool.query(
      `INSERT INTO user_phones (id, user_id, phone_e164, is_primary, verified_at) VALUES ($1, $2, $3, true, now())`,
      [uuid(), id, phone],
    );
    return id;
  }

  async function otpChallenge(): Promise<string> {
    const id = uuid();
    await pool.query(
      `INSERT INTO otp_challenges (id, target, channel, purpose, code_hash, expires_at, sent_at)
       VALUES ($1, '+2290197000045', 'whatsapp', 'login', 'h', $2, $3)`,
      [id, at(5), base],
    );
    return id;
  }

  /** Étape ouverte après un code par téléphone, pour le compte. */
  async function mfaChallenge(userId: string, now = base): Promise<string> {
    const id = uuid();
    await mfa.openAfterOtp(
      await otpChallenge(),
      {
        id,
        userId,
        tokenHash: `jeton-${id}`,
        clientKind: 'backoffice',
        deviceLabel: null,
        ip: '196.192.10.4',
        createdAt: now,
        expiresAt: new Date(now.getTime() + 5 * 60_000),
      },
      now,
    );
    return id;
  }

  function plan(challengeId: string, userId: string, proof: SecondFactorProof, now = base): MfaLoginPlan {
    return {
      mfaChallengeId: challengeId,
      userId,
      proof,
      session: {
        id: uuid(),
        clientKind: 'backoffice',
        deviceLabel: null,
        userAgent: 'Firefox',
        ip: '196.192.10.4',
        expiresAt: new Date(now.getTime() + 12 * 3600_000),
      },
      refreshToken: { id: uuid(), hash: `rt-${seq}` },
      loginEventId: uuid(),
      maxSessions: 2,
      now,
    };
  }

  /** Compte dont l'application est configurée (pas 100) avec deux codes de récupération. */
  async function enrolled(): Promise<{ userId: string; factorId: string; codeIds: string[] }> {
    const userId = await user();
    const factorId = uuid();
    await mfa.savePendingTotp({ id: factorId, userId, secretEncrypted: 'v1.a.b.c', now: base });
    const codeIds = [uuid(), uuid()];
    await mfa.completeMfaLogin(
      plan(await mfaChallenge(userId), userId, {
        kind: 'totp_enrollment',
        factorId,
        step: 100,
        recoveryCodes: codeIds.map((id) => ({ id, hash: `code-${id}` })),
      }),
    );
    return { userId, factorId, codeIds };
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
    roles = new PrismaRoleRepository(prisma);
    mfa = new PrismaMfaRepository(prisma);
    sessions = new PrismaSessionStore(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE otp_challenges, users, outbox, login_events CASCADE');
  });

  it('la migration enregistre le catalogue initial, tout rôle du back-office exige la double authentification', async () => {
    const { rows } = await pool.query(
      'SELECT code, requires_mfa, backoffice_access FROM roles ORDER BY code',
    );
    expect(rows.map((row) => row.code)).toEqual(INITIAL_BACKOFFICE_ROLES.map((role) => role.code).sort());
    expect(rows.every((row) => row.requires_mfa && row.backoffice_access)).toBe(true);
    await expect(
      pool.query(
        `INSERT INTO roles (id, service, code, scope_type, requires_mfa, backoffice_access, description)
         VALUES ($1, 'test', 'sans_mfa', 'global', false, true, 'x')`,
        [uuid()],
      ),
    ).rejects.toThrow(/roles_backoffice_requires_mfa/);
    expect(await roles.findDefinition('cleaning_agent')).toMatchObject({
      service: 'cleaning',
      scopeType: 'domain',
    });
  });

  it('attribue un rôle une seule fois, publie identity.role.granted, et lit les rôles actifs', async () => {
    const userId = await user();
    const input = {
      userId,
      roleCode: 'recovery_agent',
      scopeType: 'domain' as const,
      scopeId: 'recovery',
      grantedBy: null,
      now: base,
    };
    const first = await roles.grant({ ...input, assignmentId: uuid() });
    const again = await roles.grant({ ...input, assignmentId: uuid() });
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, assignmentId: first.assignmentId });

    const events = await pool.query('SELECT event_type, payload FROM outbox');
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].event_type).toBe('identity.role.granted');
    expect(events.rows[0].payload.payload).toMatchObject({ roleCode: 'recovery_agent', grantedBy: 'system' });

    expect(await roles.activeRoles(userId)).toEqual([
      {
        code: 'recovery_agent',
        scopeType: 'domain',
        scopeId: 'recovery',
        requiresMfa: true,
        backofficeAccess: true,
      },
    ]);
    await pool.query('UPDATE role_assignments SET revoked_at = now()');
    expect(await roles.activeRoles(userId)).toEqual([]);
  });

  it('ouvre l’étape en consommant le code par téléphone, une seule fois', async () => {
    const userId = await user();
    const otp = await otpChallenge();
    const challenge = (id: string) => ({
      id,
      userId,
      tokenHash: `jeton-${id}`,
      clientKind: 'backoffice' as const,
      deviceLabel: 'Poste du bureau',
      ip: null,
      createdAt: base,
      expiresAt: at(5),
    });
    const id = uuid();
    await mfa.openAfterOtp(otp, challenge(id), base);
    await expect(mfa.openAfterOtp(otp, challenge(uuid()), base)).rejects.toBeInstanceOf(
      ChallengeAlreadyConsumedError,
    );
    expect(await mfa.findByTokenHash(`jeton-${id}`)).toEqual({
      id,
      userId,
      clientKind: 'backoffice',
      deviceLabel: 'Poste du bureau',
      attempts: 0,
      expiresAt: at(5),
      consumedAt: null,
    });
    expect(await mfa.registerFailedAttempt(id)).toBe(1);
    expect(await mfa.registerFailedAttempt(id)).toBe(2);
  });

  it('un secret non confirmé est remplacé ; une application active ne l’est jamais', async () => {
    const userId = await user();
    await mfa.savePendingTotp({ id: uuid(), userId, secretEncrypted: 'premier', now: base });
    await mfa.savePendingTotp({ id: uuid(), userId, secretEncrypted: 'second', now: at(1) });
    expect(await mfa.findTotp(userId)).toMatchObject({ secretEncrypted: 'second', enabledAt: null });

    const { userId: enrolledUser } = await enrolled();
    await expect(
      mfa.savePendingTotp({ id: uuid(), userId: enrolledUser, secretEncrypted: 'x', now: base }),
    ).rejects.toBeInstanceOf(TotpAlreadyEnabledError);
  });

  it('la confirmation active l’application, enregistre les codes et ouvre la session back-office', async () => {
    const { userId, codeIds } = await enrolled();
    expect(await mfa.findTotp(userId)).toMatchObject({ enabledAt: base, lastUsedStep: 100 });
    expect(await mfa.countUnusedRecoveryCodes(userId)).toBe(2);
    expect(await mfa.findUnusedRecoveryCode(userId, `code-${codeIds[0]}`)).toBe(codeIds[0]);

    const opened = await pool.query('SELECT client_kind, mfa_at FROM sessions WHERE user_id = $1', [userId]);
    expect(opened.rows).toEqual([{ client_kind: 'backoffice', mfa_at: base }]);
    const events = await pool.query('SELECT method, success FROM login_events WHERE user_id = $1', [userId]);
    expect(events.rows).toEqual([{ method: 'totp', success: true }]);
    const { rows } = await pool.query('SELECT token_hash FROM refresh_tokens');
    const stored = await sessions.findRefreshToken(rows[0].token_hash);
    expect(stored?.session).toMatchObject({ clientKind: 'backoffice', mfaAt: base, lastSeenAt: base });
  });

  it('un code de l’application ne sert qu’une fois : pas égal ou antérieur refusé, tout est annulé', async () => {
    const { userId, factorId } = await enrolled();
    const replay = plan(await mfaChallenge(userId), userId, { kind: 'totp', factorId, step: 100 });
    await expect(mfa.completeMfaLogin(replay)).rejects.toBeInstanceOf(TotpStepAlreadyUsedError);
    // La transaction est annulée : l'étape reste utilisable et aucune session n'est ouverte.
    expect((await mfa.findByTokenHash(`jeton-${replay.mfaChallengeId}`))?.consumedAt).toBeNull();
    expect((await pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n).toBe(1);

    const { recoveryCodesRemaining } = await mfa.completeMfaLogin({
      ...replay,
      proof: { kind: 'totp', factorId, step: 101 },
    });
    expect(recoveryCodesRemaining).toBe(2);
    await expect(mfa.completeMfaLogin(replay)).rejects.toBeInstanceOf(MfaChallengeAlreadyConsumedError);
  });

  it('un code de récupération est consommé une seule fois', async () => {
    const { userId, codeIds } = await enrolled();
    const proof = { kind: 'recovery_code' as const, codeId: codeIds[0]! };
    const result = await mfa.completeMfaLogin(plan(await mfaChallenge(userId), userId, proof));
    expect(result.recoveryCodesRemaining).toBe(1);
    expect(await mfa.findUnusedRecoveryCode(userId, `code-${codeIds[0]}`)).toBeNull();
    await expect(
      mfa.completeMfaLogin(plan(await mfaChallenge(userId), userId, proof)),
    ).rejects.toBeInstanceOf(RecoveryCodeAlreadyUsedError);
  });

  it('une étape expirée ne peut pas être consommée', async () => {
    const { userId, factorId } = await enrolled();
    const late = plan(await mfaChallenge(userId), userId, { kind: 'totp', factorId, step: 101 }, at(6));
    await expect(mfa.completeMfaLogin(late)).rejects.toBeInstanceOf(MfaChallengeAlreadyConsumedError);
  });

  it('au plus 2 sessions back-office, sans toucher aux sessions mobiles', async () => {
    const { userId, factorId } = await enrolled();
    await pool.query(
      `INSERT INTO sessions (id, user_id, client_kind, last_seen_at, expires_at) VALUES ($1, $2, 'mobile', $3, $4)`,
      [uuid(), userId, base, at(60 * 24)],
    );
    for (const step of [101, 102]) {
      const now = at(step - 100);
      await mfa.completeMfaLogin(
        plan(await mfaChallenge(userId, now), userId, { kind: 'totp', factorId, step }, now),
      );
    }
    const active = await pool.query(
      'SELECT client_kind, count(*)::int AS n FROM sessions WHERE revoked_at IS NULL GROUP BY client_kind ORDER BY 1',
    );
    expect(active.rows).toEqual([
      { client_kind: 'mobile', n: 1 },
      { client_kind: 'backoffice', n: 2 },
    ]);
  });
});
