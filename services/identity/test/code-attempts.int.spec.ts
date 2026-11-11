import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { checkEmailCode } from '../src/application/email/email-code-check';
import { type BackofficeSessionOpener } from '../src/application/mfa/backoffice-session-opener';
import { MfaStepGuard } from '../src/application/mfa/mfa-step-guard';
import { type OpenMfaChallenge } from '../src/application/mfa/open-mfa-challenge';
import { VerifyMfaUseCase } from '../src/application/mfa/verify-mfa.use-case';
import { VerifyOtpUseCase } from '../src/application/session/verify-otp.use-case';
import { type AccessTokenIssuer } from '../src/application/token/access-token-issuer';
import { TOTP_DEFAULTS } from '../src/domain/mfa/totp';
import { type OtpPolicy } from '../src/domain/otp/otp-policy';
import { PrismaEmailVerificationRepository } from '../src/infrastructure/email/prisma-email-verification.repository';
import { PrismaMfaRepository } from '../src/infrastructure/mfa/prisma-mfa.repository';
import { PrismaOtpChallengeRepository } from '../src/infrastructure/otp/prisma-otp-challenge.repository';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { PrismaRoleRepository } from '../src/infrastructure/role/prisma-role.repository';
import { PrismaLoginRepository } from '../src/infrastructure/session/prisma-login.repository';

/**
 * Essais des codes sous la concurrence, contre un vrai PostgreSQL : des essais simultanés ne
 * doivent jamais comparer plus de codes que le plafond (ADR-050). L'essai est pris en base avant
 * la comparaison. Ignoré si TEST_DATABASE_URL n'est pas défini (la CI le fournit).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const MAX_ATTEMPTS = 5;
const CONCURRENT = 20;

const otpPolicy: OtpPolicy = {
  codeLength: 6,
  ttlSeconds: 300,
  maxAttempts: MAX_ATTEMPTS,
  resendDelaySeconds: 60,
  maxPerHour: 5,
  maxPerDay: 10,
  blockSeconds: 3600,
};

const codeOf = (error: unknown) => (error instanceof AppError ? error.code : String(error));

describeWithDatabase('Essais des codes sous la concurrence (PostgreSQL)', () => {
  const schema = `identity_attempts_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;
  let seq = 0;
  const uuid = () => `0192f1c4-7a2b-7c3d-8e4f-${String(++seq).padStart(12, '0')}`;
  const now = new Date();
  const later = new Date(now.getTime() + 5 * 60_000);

  /** Comparaisons faites : le défaut laissait chaque essai simultané comparer son code. */
  let comparisons = 0;
  const wrongHasher = {
    hash: () => 'h',
    matches: () => {
      comparisons += 1;
      return false;
    },
  };

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
    url.searchParams.set('connection_limit', '10');
    process.env.DATABASE_URL = url.toString();
    prisma = new PrismaService(new ReadinessRegistry());
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  beforeEach(() => {
    comparisons = 0;
  });

  async function user(): Promise<string> {
    const id = uuid();
    await pool.query(`INSERT INTO users (id, status, updated_at) VALUES ($1, 'active', now())`, [id]);
    return id;
  }

  /** Lance les essais en même temps et renvoie les codes d'erreur obtenus. */
  async function burst(attempt: () => Promise<unknown>): Promise<string[]> {
    const results = await Promise.allSettled(Array.from({ length: CONCURRENT }, attempt));
    return results.map((result) => (result.status === 'rejected' ? codeOf(result.reason) : 'ok'));
  }

  it('code par téléphone : pas plus de comparaisons que d’essais permis', async () => {
    const challengeId = uuid();
    await pool.query(
      `INSERT INTO otp_challenges (id, target, channel, purpose, code_hash, expires_at, sent_at)
       VALUES ($1, '+2290197000045', 'whatsapp', 'login', 'h', $2, $3)`,
      [challengeId, later, now],
    );
    const logins = new PrismaLoginRepository(prisma);
    const useCase = new VerifyOtpUseCase(
      new PrismaOtpChallengeRepository(prisma),
      logins,
      logins,
      wrongHasher,
      { generate: () => ({ token: 't', hash: 'h' }) },
      {} as AccessTokenIssuer,
      { next: uuid },
      { now: () => now },
      otpPolicy,
      { refreshTtlSeconds: 3600, maxSessions: 2 },
      {} as OpenMfaChallenge,
    );

    const outcomes = await burst(() =>
      useCase.execute({
        challengeId,
        code: '000000',
        clientKind: 'web',
        deviceLabel: null,
        ip: null,
        userAgent: null,
      }),
    );

    expect(comparisons).toBe(MAX_ATTEMPTS);
    expect(outcomes.filter((code) => code === 'IDENTITY_OTP_INVALID')).toHaveLength(MAX_ATTEMPTS - 1);
    const { rows } = await pool.query('SELECT attempts FROM otp_challenges WHERE id = $1', [challengeId]);
    expect(rows[0].attempts).toBe(MAX_ATTEMPTS);
  });

  it('code par e-mail : pas plus de comparaisons que d’essais permis', async () => {
    const userId = await user();
    const verifications = new PrismaEmailVerificationRepository(prisma);
    await pool.query(
      `INSERT INTO email_verifications (id, user_id, email, code_hash, expires_at, sent_at, created_at)
       VALUES ($1, $2, 'awa@example.com', 'h', $3, $4, $4)`,
      [uuid(), userId, later, now],
    );
    const verification = await verifications.findLatest(userId);

    await burst(() => checkEmailCode(verifications, wrongHasher, otpPolicy, verification, '000000', now));

    expect(comparisons).toBe(MAX_ATTEMPTS);
    const { rows } = await pool.query('SELECT attempts FROM email_verifications');
    expect(rows[0].attempts).toBe(MAX_ATTEMPTS);
  });

  it('double authentification : pas plus de comparaisons que d’essais permis', async () => {
    const userId = await user();
    const { rows: role } = await pool.query(`SELECT id FROM roles WHERE code = 'support_agent'`);
    await pool.query(
      `INSERT INTO role_assignments (id, user_id, role_id, scope_type, scope_id, granted_at)
       VALUES ($1, $2, $3, 'global', null, now())`,
      [uuid(), userId, role[0].id],
    );
    await pool.query(
      `INSERT INTO mfa_factors (id, user_id, type, secret_encrypted, created_at, enabled_at)
       VALUES ($1, $2, 'totp', 'secret', now(), now())`,
      [uuid(), userId],
    );
    const mfa = new PrismaMfaRepository(prisma);
    const otpId = uuid();
    await pool.query(
      `INSERT INTO otp_challenges (id, target, channel, purpose, code_hash, expires_at, sent_at)
       VALUES ($1, '+2290197000046', 'whatsapp', 'login', 'h', $2, $3)`,
      [otpId, later, now],
    );
    await mfa.openAfterOtp(
      otpId,
      {
        id: uuid(),
        userId,
        tokenHash: 'jeton',
        clientKind: 'backoffice',
        deviceLabel: null,
        ip: null,
        createdAt: now,
        expiresAt: later,
      },
      now,
    );
    const logins = new PrismaLoginRepository(prisma);
    const guard = new MfaStepGuard(
      mfa,
      { generate: () => ({ token: 'jeton', hash: 'jeton' }), hash: (token) => token },
      logins,
      new PrismaRoleRepository(prisma),
      logins,
      { next: uuid },
      { tokenTtlSeconds: 300, maxAttempts: MAX_ATTEMPTS },
    );
    const useCase = new VerifyMfaUseCase(
      guard,
      mfa,
      { generateSecret: () => 's', codeAt: () => '999999' },
      {
        encrypt: (text) => text,
        decrypt: (text) => {
          comparisons += 1;
          return text;
        },
      },
      { hash: () => 'h' },
      {} as BackofficeSessionOpener,
      { now: () => now },
      TOTP_DEFAULTS,
    );

    await burst(() =>
      useCase.execute({
        mfaToken: 'jeton',
        method: 'totp',
        code: '000000',
        clientKind: 'backoffice',
        ip: null,
        userAgent: null,
      }),
    );

    expect(comparisons).toBe(MAX_ATTEMPTS);
    const { rows } = await pool.query('SELECT attempts FROM mfa_challenges');
    expect(rows[0].attempts).toBe(MAX_ATTEMPTS);
  });
});
