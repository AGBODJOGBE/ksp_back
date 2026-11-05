import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { PrismaAccountDeletionRepository } from '../src/infrastructure/deletion/prisma-account-deletion.repository';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { PrismaLoginRepository } from '../src/infrastructure/session/prisma-login.repository';

/**
 * Test d'intégration contre un vrai PostgreSQL : suppression du compte (UC-ID-11, ADR-036) —
 * demande (gel, sessions fermées, événement), annulation, échéances à traiter, report, et
 * anonymisation complète (numéro libéré, appareils, appartenances, identity.user.deleted).
 * Ignoré si TEST_DATABASE_URL n'est pas défini (la CI le fournit).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const USER = '0192f1c4-7a2b-7c3d-8e4f-000000000001';
const OTHER = '0192f1c4-7a2b-7c3d-8e4f-000000000002';
const ORG = '0192f1c4-7a2b-7c3d-8e4f-0000000000a1';
const PHONE = '+2290197000045';
const DAY = 86_400_000;

describeWithDatabase('PrismaAccountDeletionRepository (PostgreSQL)', () => {
  const schema = `identity_deletion_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;
  let deletions: PrismaAccountDeletionRepository;
  let accounts: PrismaLoginRepository;
  const now = new Date('2026-11-05T10:00:00Z');
  const scheduledFor = new Date(now.getTime() + 30 * DAY);

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
    deletions = new PrismaAccountDeletionRepository(prisma);
    accounts = new PrismaLoginRepository(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE email_verifications, organization_members, organizations, sessions, user_phones,
        otp_challenges, login_events, mfa_factors, users CASCADE`,
    );
    await pool.query('TRUNCATE outbox');
    for (const [id, phone] of [
      [USER, PHONE],
      [OTHER, '+2290197000046'],
    ] as const) {
      await pool.query(
        `INSERT INTO users (id, status, first_name, last_name, email, email_verified_at, updated_at)
         VALUES ($1, 'active', 'Koffi', 'Adjovi', $2, now(), now())`,
        [id, `${id.slice(-4)}@exemple.com`],
      );
      await pool.query(
        `INSERT INTO user_phones (id, user_id, phone_e164, is_primary, verified_at) VALUES ($1, $2, $3, true, now())`,
        [`${id.slice(0, -4)}f${id.slice(-3)}`, id, phone],
      );
    }
    await pool.query(
      `INSERT INTO sessions (id, user_id, client_kind, ip, user_agent, created_at, last_seen_at, expires_at)
       VALUES ('0192f1c4-7a2b-7c3d-8e4f-0000000005e1', $1, 'web', '196.192.10.4', 'Firefox', $2, $2, $3)`,
      [USER, now, new Date(now.getTime() + 30 * DAY)],
    );
    await pool.query(
      `INSERT INTO login_events (id, user_id, method, success, ip, user_agent, created_at)
       VALUES ('0192f1c4-7a2b-7c3d-8e4f-0000000001e1', $1, 'phone_otp', true, '196.192.10.4', 'Firefox', $2)`,
      [USER, now],
    );
    await pool.query(
      `INSERT INTO otp_challenges (id, target, channel, purpose, code_hash, expires_at)
       VALUES ('0192f1c4-7a2b-7c3d-8e4f-0000000000c1', $1, 'whatsapp', 'login', 'h', $2)`,
      [PHONE, now],
    );
  });

  const outbox = async () =>
    (await pool.query('SELECT event_type, payload FROM outbox ORDER BY created_at, event_type')).rows as {
      event_type: string;
      payload: { payload: Record<string, unknown> };
    }[];

  const addOrganization = async (admins: string[], status = 'active') => {
    await pool.query(
      `INSERT INTO organizations (id, legal_name, address, ifu, status, created_by, created_at, updated_at)
       VALUES ($1, 'SARL Bénin Propre', 'Cotonou', '3201912345678', $2, $3, now(), now())`,
      [ORG, status, admins[0]],
    );
    for (const [index, admin] of admins.entries()) {
      await pool.query(
        `INSERT INTO organization_members (id, organization_id, user_id, role, joined_at)
         VALUES ($1, $2, $3, 'org_admin', now())`,
        [`0192f1c4-7a2b-7c3d-8e4f-0000000000b${index}`, ORG, admin],
      );
    }
  };

  it('demande : compte gelé, sessions fermées, événement ; idempotente', async () => {
    expect(await deletions.requestDeletion({ userId: USER, requestedAt: now, scheduledFor })).toBe(true);
    expect(await deletions.requestDeletion({ userId: USER, requestedAt: now, scheduledFor })).toBe(false);
    const account = await accounts.findById(USER);
    expect(account).toMatchObject({
      status: 'deletion_pending',
      deletion: { requestedAt: now, scheduledFor, postponedBy: [] },
    });
    const sessions = await pool.query('SELECT revoked_at, revoke_reason FROM sessions WHERE user_id = $1', [
      USER,
    ]);
    expect(sessions.rows).toEqual([{ revoked_at: now, revoke_reason: 'account_deletion_requested' }]);
    const events = await outbox();
    expect(events.map((event) => event.event_type)).toEqual(['identity.user.deletion_requested']);
  });

  it('annulation : compte actif, champs de suppression effacés, événement', async () => {
    await deletions.requestDeletion({ userId: USER, requestedAt: now, scheduledFor });
    expect(await deletions.cancelDeletion(USER, now)).toBe(true);
    expect(await deletions.cancelDeletion(USER, now)).toBe(false);
    expect(await accounts.findById(USER)).toMatchObject({ status: 'active', deletion: null });
    expect((await outbox()).map((event) => event.event_type)).toContain('identity.user.deletion_cancelled');
  });

  it('échéances : seulement les comptes échus, report enregistré et recontrôlé après le délai', async () => {
    await deletions.requestDeletion({ userId: USER, requestedAt: now, scheduledFor });
    const due = new Date(scheduledFor.getTime() + 1000);
    expect(await deletions.listDue({ now: now, recheckBefore: now, limit: 10 })).toEqual([]);
    expect(await deletions.listDue({ now: due, recheckBefore: due, limit: 10 })).toEqual([USER]);

    const obstacle = {
      service: 'billing',
      kind: 'unpaid_invoice',
      reference: 'FAC-1',
      description: 'Facture',
    };
    await deletions.markChecked(USER, due, [obstacle]);
    expect(
      await deletions.listDue({ now: due, recheckBefore: new Date(due.getTime() - 1), limit: 10 }),
    ).toEqual([]);
    expect(await deletions.listDue({ now: due, recheckBefore: due, limit: 10 })).toEqual([USER]);
    expect((await accounts.findById(USER))?.deletion?.postponedBy).toEqual([obstacle]);
  });

  it('seul administrateur : organisation signalée, sauf si un autre administrateur reste', async () => {
    await addOrganization([USER]);
    expect(await deletions.soleAdministeredOrganizations(USER)).toEqual([
      { id: ORG, legalName: 'SARL Bénin Propre' },
    ]);
    await pool.query('TRUNCATE organization_members, organizations CASCADE');
    await addOrganization([USER, OTHER]);
    expect(await deletions.soleAdministeredOrganizations(USER)).toEqual([]);
    await pool.query(`UPDATE users SET status = 'deletion_pending' WHERE id = $1`, [OTHER]);
    expect(await deletions.soleAdministeredOrganizations(USER)).toHaveLength(1);
    await pool.query(`UPDATE organizations SET status = 'rejected'`);
    expect(await deletions.soleAdministeredOrganizations(USER)).toEqual([]);
  });

  it('anonymisation : données effacées, numéro libre, appartenances retirées, événements ; une seule fois', async () => {
    await addOrganization([USER, OTHER]);
    await deletions.requestDeletion({ userId: USER, requestedAt: now, scheduledFor });
    expect(await deletions.anonymize(USER, now)).toBe(false);
    const due = new Date(scheduledFor.getTime() + 1000);
    expect(await deletions.anonymize(USER, due)).toBe(true);
    expect(await deletions.anonymize(USER, due)).toBe(false);

    const user = await pool.query(
      'SELECT status, first_name, last_name, email, email_verified_at, anonymized_at FROM users WHERE id = $1',
      [USER],
    );
    expect(user.rows[0]).toEqual({
      status: 'deleted',
      first_name: null,
      last_name: null,
      email: null,
      email_verified_at: null,
      anonymized_at: due,
    });
    expect((await pool.query('SELECT 1 FROM user_phones WHERE user_id = $1', [USER])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM otp_challenges WHERE target = $1', [PHONE])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM sessions WHERE user_id = $1', [USER])).rowCount).toBe(0);
    expect(
      (await pool.query('SELECT ip, user_agent FROM login_events WHERE user_id = $1', [USER])).rows,
    ).toEqual([{ ip: null, user_agent: null }]);
    expect(
      (await pool.query('SELECT removed_at FROM organization_members WHERE user_id = $1', [USER])).rows,
    ).toEqual([{ removed_at: due }]);
    expect(await accounts.findByPhone(PHONE)).toBeNull();
    expect(await accounts.findById(OTHER)).toMatchObject({ status: 'active', firstName: 'Koffi' });

    const events = await outbox();
    expect(events.map((event) => event.event_type)).toEqual(
      expect.arrayContaining(['identity.member.removed', 'identity.user.deleted']),
    );
    expect(events.filter((event) => event.event_type === 'identity.user.deleted')).toHaveLength(1);
  });

  it('anonymisation : une annulation de dernière minute l’emporte', async () => {
    await deletions.requestDeletion({ userId: USER, requestedAt: now, scheduledFor });
    await deletions.cancelDeletion(USER, now);
    expect(await deletions.anonymize(USER, new Date(scheduledFor.getTime() + 1000))).toBe(false);
    expect(await accounts.findById(USER)).toMatchObject({ status: 'active', firstName: 'Koffi' });
  });
});
