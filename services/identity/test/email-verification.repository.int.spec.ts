import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import {
  EmailAlreadyUsedError,
  VerificationAlreadyConsumedError,
} from '../src/application/email/email.ports';
import { EmailAddress } from '../src/domain/user/email-address';
import { PrismaEmailVerificationRepository } from '../src/infrastructure/email/prisma-email-verification.repository';
import { PrismaLoginRepository } from '../src/infrastructure/session/prisma-login.repository';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

/**
 * Test d'intégration contre un vrai PostgreSQL : demandes de confirmation de l'e-mail du profil,
 * confirmation (adresse unique entre comptes) et événements de l'outbox.
 * Ignoré si TEST_DATABASE_URL n'est pas défini (la CI le fournit).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const USER_1 = '0192f1c4-7a2b-7c3d-8e4f-000000000001';
const USER_2 = '0192f1c4-7a2b-7c3d-8e4f-000000000002';
const koffi = EmailAddress.parse('koffi@exemple.com')!;

describeWithDatabase('PrismaEmailVerificationRepository (PostgreSQL)', () => {
  const schema = `identity_email_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;
  let repository: PrismaEmailVerificationRepository;
  let accounts: PrismaLoginRepository;
  let seq = 100;
  const uuid = () => `0192f1c4-7a2b-7c3d-8e4f-${String(++seq).padStart(12, '0')}`;
  const base = new Date('2026-10-27T12:00:00Z');
  const at = (minutes: number) => new Date(base.getTime() + minutes * 60_000);
  const event = {
    userId: USER_1,
    purpose: 'email_verification' as const,
    channel: 'email' as const,
    targetMasked: 'k***@exemple.com',
  };

  async function request(userId: string, email: EmailAddress, createdAt: Date): Promise<string> {
    const id = uuid();
    await repository.create({
      id,
      userId,
      organizationId: null,
      email,
      codeHash: 'empreinte',
      expiresAt: new Date(createdAt.getTime() + 900_000),
      ip: '196.192.10.4',
      createdAt,
    });
    return id;
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
    repository = new PrismaEmailVerificationRepository(prisma);
    accounts = new PrismaLoginRepository(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE email_verifications, users CASCADE');
    await pool.query('TRUNCATE outbox');
    for (const id of [USER_1, USER_2]) {
      await pool.query(`INSERT INTO users (id, status, updated_at) VALUES ($1, 'active', now())`, [id]);
    }
  });

  it('marque l’envoi et écrit identity.otp.requested dans l’outbox, sans le code', async () => {
    const id = await request(USER_1, koffi, base);
    await repository.markSent(id, base, event);

    const outbox = await pool.query('SELECT event_type, payload FROM outbox');
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].event_type).toBe('identity.otp.requested');
    expect(outbox.rows[0].payload.payload).toEqual(event);
    expect(await repository.sentAtForEmailSince(koffi, at(-1))).toEqual([base]);
    expect(await repository.sentAtForUserSince(USER_1, at(-1))).toEqual([base]);
    expect(await repository.sentAtForUserSince(USER_2, at(-1))).toEqual([]);
  });

  it('la dernière demande du compte est la seule lue, même en échec d’envoi', async () => {
    const first = await request(USER_1, koffi, at(0));
    await repository.markSent(first, at(0), event);
    const second = await request(USER_1, EmailAddress.parse('autre@exemple.com')!, at(5));
    await repository.markSendFailed(second, at(5));

    await expect(repository.findLatest(USER_1)).resolves.toMatchObject({
      id: second,
      userId: USER_1,
      target: 'autre@exemple.com',
      sendFailedAt: at(5),
    });
    await expect(repository.findLatest(USER_2)).resolves.toBeNull();
    expect(await repository.registerFailedAttempt(second)).toBe(1);
  });

  it('la confirmation enregistre l’adresse vérifiée et publie identity.user.verified, une seule fois', async () => {
    const id = await request(USER_1, koffi, base);
    await repository.markSent(id, base, event);

    const account = await repository.confirm({
      verificationId: id,
      userId: USER_1,
      email: koffi.value,
      now: at(2),
    });
    expect(account).toMatchObject({ id: USER_1, email: 'koffi@exemple.com', emailVerifiedAt: at(2) });
    await expect(accounts.findById(USER_1)).resolves.toMatchObject({ email: 'koffi@exemple.com' });
    const outbox = await pool.query("SELECT payload FROM outbox WHERE event_type = 'identity.user.verified'");
    expect(outbox.rows.map((row) => row.payload.payload)).toEqual([{ userId: USER_1, verifiedVia: 'email' }]);

    await expect(
      repository.confirm({ verificationId: id, userId: USER_1, email: koffi.value, now: at(3) }),
    ).rejects.toBeInstanceOf(VerificationAlreadyConsumedError);
  });

  it('une adresse déjà confirmée par un autre compte est refusée, sans consommer la demande', async () => {
    await pool.query(`UPDATE users SET email = $1, email_verified_at = now() WHERE id = $2`, [
      koffi.value,
      USER_2,
    ]);
    const id = await request(USER_1, koffi, base);

    await expect(
      repository.confirm({ verificationId: id, userId: USER_1, email: koffi.value, now: at(2) }),
    ).rejects.toBeInstanceOf(EmailAlreadyUsedError);
    const { rows } = await pool.query('SELECT consumed_at FROM email_verifications WHERE id = $1', [id]);
    expect(rows).toEqual([{ consumed_at: null }]);
    await expect(accounts.findById(USER_1)).resolves.toMatchObject({ email: null, emailVerifiedAt: null });
  });
});
