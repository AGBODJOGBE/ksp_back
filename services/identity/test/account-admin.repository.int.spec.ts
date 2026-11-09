import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { AccountStatusChangedError } from '../src/application/account-admin/account-admin.ports';
import { LastSuperAdminError, RoleAssignmentRevokedError } from '../src/application/role/role.ports';
import { PrismaAccountAdminRepository } from '../src/infrastructure/account-admin/prisma-account-admin.repository';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { PrismaRoleRepository } from '../src/infrastructure/role/prisma-role.repository';

/**
 * Test d'intégration contre un vrai PostgreSQL : administration des comptes (ADR-043) — recherche,
 * attribution et retrait avec événement et trace, dernier super administrateur protégé (verrou),
 * suspension conditionnelle qui ferme les sessions, réinitialisation de la double authentification.
 * Ignoré si TEST_DATABASE_URL n'est pas défini (la CI le fournit).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const DIRECTOR = '0192f1c4-7a2b-7c3d-8e4f-00000000ad01';
const DEPUTY = '0192f1c4-7a2b-7c3d-8e4f-00000000ad02';
const AGENT = '0192f1c4-7a2b-7c3d-8e4f-00000000a001';
const CUSTOMER = '0192f1c4-7a2b-7c3d-8e4f-00000000c001';
const SUPER_ADMIN_ROLE_ID = '019a0000-0000-7000-8000-000000000001';
const CLEANING_AGENT_ROLE_ID = '019a0000-0000-7000-8000-000000000006';

describeWithDatabase('PrismaAccountAdminRepository (PostgreSQL)', () => {
  const schema = `identity_admin_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;
  let accounts: PrismaAccountAdminRepository;
  let roles: PrismaRoleRepository;
  let seq = 100;
  const uuid = () => `0192f1c4-7a2b-7c3d-8e4f-${String(++seq).padStart(12, '0')}`;
  const now = new Date('2026-11-07T10:00:00Z');

  const assign = (id: string, userId: string, roleId: string, scopeId: string | null) =>
    pool.query(
      `INSERT INTO role_assignments (id, user_id, role_id, scope_type, scope_id, granted_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [id, userId, roleId, scopeId ? 'domain' : 'global', scopeId],
    );

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
    accounts = new PrismaAccountAdminRepository(prisma);
    roles = new PrismaRoleRepository(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE role_assignments, mfa_factors, mfa_recovery_codes, sessions, users CASCADE');
    await pool.query('TRUNCATE outbox, audit_log');
    const people: [string, string, string][] = [
      [DIRECTOR, 'Afi', '+2290197000001'],
      [DEPUTY, 'Sena', '+2290197000002'],
      [AGENT, 'Awa', '+2290197000045'],
      [CUSTOMER, 'Koffi', '+2290197000099'],
    ];
    for (const [id, name, phone] of people) {
      await pool.query(
        `INSERT INTO users (id, status, first_name, last_name, updated_at) VALUES ($1, 'active', $2, 'Dossou', now())`,
        [id, name],
      );
      await pool.query(
        `INSERT INTO user_phones (id, user_id, phone_e164, is_primary) VALUES ($1, $2, $3, true)`,
        [uuid(), id, phone],
      );
    }
    await assign(uuid(), DIRECTOR, SUPER_ADMIN_ROLE_ID, null);
    await assign(uuid(), DEPUTY, SUPER_ADMIN_ROLE_ID, null);
    await assign(uuid(), AGENT, CLEANING_AGENT_ROLE_ID, 'cleaning');
  });

  it('recherche : équipe, nom insensible à la casse, numéro, équipe d’un métier', async () => {
    const staff = await accounts.search({ query: { kind: 'staff' }, teamOf: null, limit: 20, cursor: null });
    expect(staff.items.map((item) => item.id)).toEqual([DEPUTY, DIRECTOR, AGENT]);
    const byName = await accounts.search({
      query: { kind: 'name', words: ['koffi', 'DOSS'] },
      teamOf: null,
      limit: 20,
      cursor: null,
    });
    expect(byName.items).toEqual([
      expect.objectContaining({ id: CUSTOMER, phoneE164: '+2290197000099', roleCodes: [] }),
    ]);
    const team = await accounts.search({
      query: { kind: 'staff' },
      teamOf: ['cleaning'],
      limit: 1,
      cursor: null,
    });
    expect(team).toEqual({ items: [expect.objectContaining({ id: AGENT })], nextCursor: null });
  });

  it('attribution du back-office : motif, événement, trace ; retrait : auteur, motif, événement', async () => {
    const assignmentId = uuid();
    await roles.grant({
      assignmentId,
      userId: CUSTOMER,
      roleCode: 'cleaning_supervisor',
      scopeType: 'domain',
      scopeId: 'cleaning',
      grantedBy: DIRECTOR,
      now,
      audit: { id: uuid(), reason: 'Renfort' },
    });
    await roles.revoke({
      assignmentId,
      userId: CUSTOMER,
      actorId: DEPUTY,
      reason: 'Fin du renfort',
      auditId: uuid(),
      now,
    });
    await expect(
      roles.revoke({ assignmentId, userId: CUSTOMER, actorId: DEPUTY, reason: 'x', auditId: uuid(), now }),
    ).rejects.toBeInstanceOf(RoleAssignmentRevokedError);

    const [assignment] = await accounts.assignments(CUSTOMER);
    expect(assignment).toMatchObject({
      grantedByName: 'Afi Dossou',
      grantReason: 'Renfort',
      revokedBy: DEPUTY,
      revokedByName: 'Sena Dossou',
      revokeReason: 'Fin du renfort',
    });
    const outbox = await pool.query('SELECT event_type, payload FROM outbox ORDER BY created_at, id');
    expect(outbox.rows.map((row) => row.event_type)).toEqual([
      'identity.role.granted',
      'identity.role.revoked',
    ]);
    // La colonne payload porte l'enveloppe ; le contenu de l'événement est sous payload.
    expect(outbox.rows[1].payload.payload).toMatchObject({ reason: 'Fin du renfort', revokedBy: DEPUTY });
    const history = await accounts.history(CUSTOMER, 50);
    expect(history.map((entry) => [entry.action, entry.roleCode, entry.reason])).toEqual([
      ['user.role_revoked', 'cleaning_supervisor', 'Fin du renfort'],
      ['user.role_granted', 'cleaning_supervisor', 'Renfort'],
    ]);
  });

  it('jamais sans super administrateur actif, même avec deux retraits simultanés', async () => {
    const [director] = await accounts.assignments(DIRECTOR);
    const [deputy] = await accounts.assignments(DEPUTY);
    const results = await Promise.allSettled([
      roles.revoke({
        assignmentId: director!.id,
        userId: DIRECTOR,
        actorId: DEPUTY,
        reason: 'r',
        auditId: uuid(),
        now,
      }),
      roles.revoke({
        assignmentId: deputy!.id,
        userId: DEPUTY,
        actorId: DIRECTOR,
        reason: 'r',
        auditId: uuid(),
        now,
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(LastSuperAdminError);
  });

  it('suspension conditionnelle : sessions fermées, événement ; le dernier super administrateur reste', async () => {
    await pool.query(
      `INSERT INTO sessions (id, user_id, client_kind, last_seen_at, expires_at) VALUES ($1, $2, 'web', now(), now() + interval '1 day')`,
      [uuid(), AGENT],
    );
    const change = {
      userId: AGENT,
      action: 'suspend' as const,
      from: 'active' as const,
      to: 'suspended' as const,
    };
    await accounts.changeStatus({ ...change, actorId: DIRECTOR, reason: 'Fraude', auditId: uuid(), now });
    await expect(
      accounts.changeStatus({ ...change, actorId: DIRECTOR, reason: 'Fraude', auditId: uuid(), now }),
    ).rejects.toBeInstanceOf(AccountStatusChangedError);
    await expect(accounts.findAccount(AGENT)).resolves.toMatchObject({
      status: 'suspended',
      suspensionReason: 'Fraude',
    });
    const sessions = await pool.query('SELECT revoke_reason FROM sessions WHERE user_id = $1', [AGENT]);
    expect(sessions.rows).toEqual([{ revoke_reason: 'account_suspended' }]);

    await accounts.changeStatus({
      userId: DEPUTY,
      action: 'suspend',
      from: 'active',
      to: 'suspended',
      actorId: DIRECTOR,
      reason: 'Départ',
      auditId: uuid(),
      now,
    });
    await expect(
      accounts.changeStatus({
        userId: DIRECTOR,
        action: 'suspend',
        from: 'active',
        to: 'suspended',
        actorId: DEPUTY,
        reason: 'Départ',
        auditId: uuid(),
        now,
      }),
    ).rejects.toBeInstanceOf(LastSuperAdminError);
  });

  it('réinitialisation : application et codes effacés, sessions du back-office fermées', async () => {
    await pool.query(
      `INSERT INTO mfa_factors (id, user_id, type, secret_encrypted, created_at, enabled_at) VALUES ($1, $2, 'totp', 'v1:x', now(), now())`,
      [uuid(), AGENT],
    );
    await pool.query(
      `INSERT INTO mfa_recovery_codes (id, user_id, code_hash, created_at) VALUES ($1, $2, 'h1', now())`,
      [uuid(), AGENT],
    );
    await pool.query(
      `INSERT INTO sessions (id, user_id, client_kind, last_seen_at, expires_at, mfa_at) VALUES ($1, $2, 'backoffice', now(), now() + interval '1 hour', now())`,
      [uuid(), AGENT],
    );
    await expect(accounts.mfaStatus(AGENT)).resolves.toMatchObject({
      recoveryCodesRemaining: 1,
      resettable: true,
    });
    const reset = () =>
      accounts.resetMfa({ userId: AGENT, actorId: DIRECTOR, reason: 'Perte', auditId: uuid(), now });
    await expect(reset()).resolves.toBe(true);
    await expect(reset()).resolves.toBe(false);
    await expect(accounts.mfaStatus(AGENT)).resolves.toEqual({
      configuredAt: null,
      recoveryCodesRemaining: 0,
      resettable: false,
    });
    const sessions = await pool.query('SELECT revoke_reason FROM sessions WHERE user_id = $1', [AGENT]);
    expect(sessions.rows).toEqual([{ revoke_reason: 'mfa_reset' }]);
  });
});
