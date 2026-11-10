import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { RefreshSessionUseCase } from '../src/application/session/refresh-session.use-case';
import { type AccessTokenIssuer } from '../src/application/token/access-token-issuer';
import { PrismaOrganizationRepository } from '../src/infrastructure/organization/prisma-organization.repository';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { PrismaRoleRepository } from '../src/infrastructure/role/prisma-role.repository';
import {
  HmacRefreshTokenSuccessor,
  hashRefreshToken,
} from '../src/infrastructure/session/crypto-refresh-token-generator';
import { PrismaLoginRepository } from '../src/infrastructure/session/prisma-login.repository';
import { PrismaSessionStore } from '../src/infrastructure/session/prisma-session.store';

/**
 * Renouvellement depuis plusieurs onglets, contre un vrai PostgreSQL (ADR-050) : deux onglets qui
 * renouvellent avec le même jeton, en même temps ou à quelques secondes d'écart, reçoivent le même
 * nouveau jeton ; au-delà du délai de grâce, la réutilisation reste traitée comme un vol.
 * Ignoré si TEST_DATABASE_URL n'est pas défini (la CI le fournit).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const GRACE_SECONDS = 10;
const SECRET = 'test-only-refresh-secret-0123456789abcdef';

const codeOf = (error: unknown) => (error instanceof AppError ? error.code : String(error));

describeWithDatabase('Renouvellement entre onglets (PostgreSQL)', () => {
  const schema = `identity_refresh_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;
  let useCase: RefreshSessionUseCase;
  let seq = 0;
  const uuid = () => `0192f1c4-7a2b-7c3d-8e4f-${String(++seq).padStart(12, '0')}`;
  const start = new Date();
  let now = start;

  /** Session web ouverte par la vraie transaction de connexion, avec un jeton connu. */
  async function openSession(): Promise<{ sessionId: string; token: string }> {
    const challengeId = uuid();
    const phone = `+22901970${String(++seq).padStart(5, '0')}`;
    await pool.query(
      `INSERT INTO otp_challenges (id, target, channel, purpose, code_hash, expires_at, sent_at)
       VALUES ($1, $2, 'whatsapp', 'login', 'h', $3, $4)`,
      [challengeId, phone, new Date(start.getTime() + 300_000), start],
    );
    const sessionId = uuid();
    const token = `jeton-initial-${sessionId}`;
    await new PrismaLoginRepository(prisma).completePhoneLogin({
      challengeId,
      phoneE164: phone,
      existingUserId: null,
      newUserId: uuid(),
      newPhoneId: uuid(),
      session: {
        id: sessionId,
        clientKind: 'web',
        deviceLabel: null,
        userAgent: null,
        ip: null,
        expiresAt: new Date(start.getTime() + 3600_000),
      },
      refreshToken: { id: uuid(), hash: hashRefreshToken(token) },
      loginEventId: uuid(),
      maxSessions: 5,
      now: start,
    });
    return { sessionId, token };
  }

  const revokedReason = async (sessionId: string) =>
    (await pool.query('SELECT revoke_reason FROM sessions WHERE id = $1', [sessionId])).rows[0].revoke_reason;

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
    const accessTokens = {
      issue: async () => ({
        token: `jwt-${uuid()}`,
        tokenId: uuid(),
        expiresAt: new Date(now.getTime() + 900_000),
        activeContext: { type: 'individual' as const, organizationId: null },
      }),
    } as unknown as AccessTokenIssuer;
    const policy = { refreshTtlSeconds: 3600, maxSessions: 5 };
    useCase = new RefreshSessionUseCase(
      new PrismaSessionStore(prisma),
      new HmacRefreshTokenSuccessor(SECRET),
      hashRefreshToken,
      accessTokens,
      { next: uuid },
      { now: () => now },
      { customer: policy, backoffice: policy },
      new PrismaRoleRepository(prisma),
      new PrismaOrganizationRepository(prisma),
      GRACE_SECONDS,
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  beforeEach(() => {
    now = start;
  });

  it('deux onglets en même temps : même nouveau jeton, session gardée', async () => {
    const { sessionId, token } = await openSession();

    const [first, second] = await Promise.all([useCase.execute(token), useCase.execute(token)]);

    expect(second.refreshToken).toBe(first.refreshToken);
    expect(await revokedReason(sessionId)).toBeNull();
    // Le nouveau jeton sert normalement ensuite.
    now = new Date(start.getTime() + 60_000);
    await expect(useCase.execute(first.refreshToken)).resolves.toMatchObject({ sessionId });
  });

  it('second onglet quelques secondes plus tard : même nouveau jeton', async () => {
    const { sessionId, token } = await openSession();
    const first = await useCase.execute(token);

    now = new Date(start.getTime() + (GRACE_SECONDS - 1) * 1000);
    const second = await useCase.execute(token);

    expect(second.refreshToken).toBe(first.refreshToken);
    expect(await revokedReason(sessionId)).toBeNull();
  });

  it('au-delà du délai de grâce, l’ancien jeton signale un vol : session révoquée', async () => {
    const { sessionId, token } = await openSession();
    await useCase.execute(token);

    now = new Date(start.getTime() + (GRACE_SECONDS + 1) * 1000);
    await expect(useCase.execute(token).catch(codeOf)).resolves.toBe('IDENTITY_REFRESH_TOKEN_REUSED');
    expect(await revokedReason(sessionId)).toBe('refresh_token_reused');
  });

  it('pendant le délai, un ancien jeton dont le successeur a déjà servi signale un vol', async () => {
    const { sessionId, token } = await openSession();
    const first = await useCase.execute(token);
    now = new Date(start.getTime() + 2000);
    await useCase.execute(first.refreshToken);

    now = new Date(start.getTime() + 3000);
    await expect(useCase.execute(token).catch(codeOf)).resolves.toBe('IDENTITY_REFRESH_TOKEN_REUSED');
    expect(await revokedReason(sessionId)).toBe('refresh_token_reused');
  });
});
