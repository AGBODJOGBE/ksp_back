import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { RoleCodeTakenError, RoleInUseError } from '../src/application/rbac/rbac.ports';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { PrismaRbacRepository } from '../src/infrastructure/rbac/prisma-rbac.repository';
import { PrismaRoleRepository } from '../src/infrastructure/role/prisma-role.repository';

/**
 * Test d'intégration contre un vrai PostgreSQL : RBAC dynamique (ADR-057) — catalogue déclaré par un
 * service (rejouable, permissions retirées, rôles livrés jamais écrasés), rôle créé, modifié et
 * désactivé avec événement et trace, permissions et zones lues pour le jeton.
 * Ignoré si TEST_DATABASE_URL n'est pas défini (la CI le fournit).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const DIRECTOR = '0192f1c4-7a2b-7c3d-8e4f-00000000ad01';
const SUPERVISOR = '0192f1c4-7a2b-7c3d-8e4f-00000000ad02';
const SUPER_ADMIN_ROLE_ID = '019a0000-0000-7000-8000-000000000001';

describeWithDatabase('PrismaRbacRepository (PostgreSQL)', () => {
  const schema = `identity_rbac_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;
  let rbac: PrismaRbacRepository;
  let roles: PrismaRoleRepository;
  let seq = 100;
  const uuid = () => `0192f1c4-7a2b-7c3d-8e4f-${String(++seq).padStart(12, '0')}`;
  const now = new Date('2026-11-20T10:00:00Z');
  const write = () => ({ actorId: DIRECTOR, reason: 'Organisation', auditId: uuid(), now });

  const catalog = (version: number, codes: string[]) => ({
    service: 'cleaning',
    version,
    permissions: codes.map((code) => ({ code, description: `Permet ${code}` })),
    roles: [
      {
        code: 'cleaning_supervisor',
        name: 'Superviseur (catalogue)',
        description: 'Superviseur',
        scopeType: 'domain' as const,
        requiresMfa: true,
        backofficeAccess: true,
        sensitive: false,
        permissions: ['cleaning.request.read'],
      },
      {
        code: 'cleaning_auditor',
        name: 'Auditeur Nettoyage',
        description: 'Lecture seule',
        scopeType: 'global' as const,
        requiresMfa: true,
        backofficeAccess: true,
        sensitive: false,
        permissions: ['cleaning.request.read'],
      },
    ],
    now,
    newRoleId: uuid,
    newAuditId: uuid,
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
    process.env.DATABASE_URL = url.toString();
    prisma = new PrismaService(new ReadinessRegistry());
    await prisma.$connect();
    rbac = new PrismaRbacRepository(prisma);
    roles = new PrismaRoleRepository(prisma);
    for (const id of [DIRECTOR, SUPERVISOR]) {
      await pool.query(
        `INSERT INTO users (id, status, first_name, last_name, updated_at) VALUES ($1, 'active', 'A', 'B', now())`,
        [id],
      );
    }
    await pool.query(
      `INSERT INTO role_assignments (id, user_id, role_id, scope_type, granted_at) VALUES ($1, $2, $3, 'global', now())`,
      [uuid(), DIRECTOR, SUPER_ADMIN_ROLE_ID],
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  it('enregistre le catalogue, rejouable ; une permission absente est retirée puis rétablie', async () => {
    const codes = ['cleaning.request.read', 'cleaning.planning.manage', 'cleaning.zone.manage'];
    expect(await rbac.register(catalog(1, codes))).toEqual({
      permissionsAdded: 3,
      permissionsRetired: 0,
      rolesCreated: 1,
    });
    // Rôle déjà livré par la migration, jamais modifié au back-office : nom gardé, permissions
    // déclarées pour lui ajoutées, tracées avec le service pour auteur ; rôle nouveau : créé.
    expect(await rbac.find('cleaning_supervisor')).toMatchObject({
      name: 'Superviseur Nettoyage',
      permissions: ['cleaning.request.read'],
      updatedAt: null,
      updatedBy: null,
    });
    const completed = await pool.query(
      `SELECT actor_id, entity_type, entity_id, details FROM audit_log WHERE action = 'role.default_permissions_added'`,
    );
    expect(completed.rows).toEqual([
      {
        actor_id: 'cleaning',
        entity_type: 'role',
        entity_id: 'cleaning_supervisor',
        details: {
          service: 'cleaning',
          catalogVersion: 1,
          permissionsAdded: ['cleaning.request.read'],
          before: [],
          after: ['cleaning.request.read'],
        },
      },
    ]);
    expect(await rbac.find('cleaning_auditor')).toMatchObject({
      origin: 'default',
      service: 'cleaning',
      permissions: ['cleaning.request.read'],
      active: true,
    });
    expect(await rbac.register(catalog(1, codes))).toEqual({
      permissionsAdded: 0,
      permissionsRetired: 0,
      rolesCreated: 0,
    });

    expect(
      await rbac.register(catalog(2, ['cleaning.request.read', 'cleaning.planning.manage'])),
    ).toMatchObject({
      permissionsAdded: 0,
      permissionsRetired: 1,
    });
    expect(await rbac.unusablePermissions(['cleaning.zone.manage', 'cleaning.request.read'])).toEqual([
      'cleaning.zone.manage',
    ]);
    expect((await rbac.permissions({ service: 'cleaning', includeRetired: true })).length).toBe(3);
    expect(await rbac.register(catalog(3, codes))).toMatchObject({
      permissionsAdded: 1,
      permissionsRetired: 0,
    });
  });

  it('crée, modifie et désactive un rôle, avec événement et trace d’audit dans la transaction', async () => {
    await rbac.create({
      ...write(),
      id: uuid(),
      code: 'cleaning_planner',
      name: 'Planificateur',
      description: 'Planifie',
      permissions: ['cleaning.planning.manage', 'cleaning.request.read'],
      sensitive: false,
    });
    await expect(
      rbac.create({
        ...write(),
        id: uuid(),
        code: 'cleaning_planner',
        name: 'Doublon',
        description: '',
        permissions: [],
        sensitive: false,
      }),
    ).rejects.toBeInstanceOf(RoleCodeTakenError);

    await rbac.update({
      ...write(),
      code: 'cleaning_planner',
      sensitive: true,
      permissions: ['cleaning.request.read', 'cleaning.zone.manage'],
    });
    expect(await rbac.find('cleaning_planner')).toMatchObject({
      origin: 'custom',
      sensitive: true,
      permissions: ['cleaning.request.read', 'cleaning.zone.manage'],
      updatedBy: DIRECTOR,
    });

    const events = await pool.query(
      `SELECT event_type, payload FROM outbox WHERE event_type LIKE 'identity.role.%' ORDER BY created_at, id`,
    );
    expect(events.rows.map((row: { event_type: string }) => row.event_type)).toEqual([
      'identity.role.created',
      'identity.role.updated',
    ]);
    expect(events.rows[1].payload.payload).toMatchObject({
      roleCode: 'cleaning_planner',
      sensitive: true,
      permissionsAdded: ['cleaning.zone.manage'],
      permissionsRemoved: ['cleaning.planning.manage'],
      updatedBy: DIRECTOR,
    });
    const audit = await pool.query(
      `SELECT action, details FROM audit_log WHERE entity_type = 'role' AND entity_id = 'cleaning_planner' ORDER BY at, action`,
    );
    expect(audit.rows.map((row: { action: string }) => row.action).sort()).toEqual([
      'role.created',
      'role.updated',
    ]);
    const updated = audit.rows.find((row: { action: string }) => row.action === 'role.updated');
    expect(updated.details.before.permissions).toEqual(['cleaning.planning.manage', 'cleaning.request.read']);
    expect(updated.details.after.permissions).toEqual(['cleaning.request.read', 'cleaning.zone.manage']);
  });

  it('rôles par défaut : complétés tant qu’aucun administrateur ne les a modifiés, jamais écrasés ensuite', async () => {
    const codes = ['cleaning.request.read', 'cleaning.planning.manage', 'cleaning.zone.manage'];
    const defaults = (code: string, permissions: string[], backofficeAccess = true) => ({
      code,
      name: 'Nom du catalogue',
      description: 'Rôle livré par défaut',
      scopeType: 'domain' as const,
      requiresMfa: backofficeAccess,
      backofficeAccess,
      sensitive: false,
      permissions,
    });
    // cleaning_admin est modifié au back-office avant la déclaration : il ne sera plus touché.
    await rbac.update({ ...write(), code: 'cleaning_admin', name: 'Admin Nettoyage (modifié)' });
    const registration = (version: number) => ({
      ...catalog(version, codes),
      roles: [
        defaults('cleaning_admin', codes),
        defaults('cleaning_agent', ['cleaning.planning.manage'], false),
        // Rôle d'un autre service : seule la part cleaning.* est ajoutée.
        defaults('finance_officer', ['cleaning.zone.manage']),
      ],
    });
    const audits = async () =>
      (
        await pool.query(
          `SELECT entity_id FROM audit_log WHERE action = 'role.default_permissions_added' ORDER BY entity_id`,
        )
      ).rows.map((row) => row.entity_id as string);
    const before = await audits();

    expect(await rbac.register(registration(10))).toMatchObject({ rolesCreated: 0 });
    expect(await rbac.find('cleaning_admin')).toMatchObject({
      name: 'Admin Nettoyage (modifié)',
      permissions: [],
    });
    // Migration 0013 : rôle de terrain, ni back-office ni double authentification ; complété.
    expect(await rbac.find('cleaning_agent')).toMatchObject({
      name: 'Agent de nettoyage',
      permissions: ['cleaning.planning.manage'],
      backofficeAccess: false,
      requiresMfa: false,
      updatedBy: null,
    });
    expect(await rbac.find('finance_officer')).toMatchObject({
      service: 'wallet',
      permissions: ['cleaning.zone.manage'],
    });
    expect(await audits()).toEqual([...before, 'cleaning_agent', 'finance_officer'].sort());

    // Déclaration suivante : ajout seulement, jamais de retrait ; rejouée, elle est sans effet.
    const next = {
      ...registration(11),
      roles: [defaults('cleaning_agent', ['cleaning.request.read'], false)],
    };
    await rbac.register(next);
    await rbac.register(next);
    expect((await rbac.find('cleaning_agent'))?.permissions).toEqual([
      'cleaning.planning.manage',
      'cleaning.request.read',
    ]);
    expect(await audits()).toHaveLength(before.length + 3);
  });

  it('permissions et zones lues pour le jeton ; un rôle attribué ne se désactive pas', async () => {
    const roleId = (await pool.query(`SELECT id FROM roles WHERE code = 'cleaning_planner'`)).rows[0]
      .id as string;
    await pool.query(
      `INSERT INTO role_assignments (id, user_id, role_id, scope_type, zone_keys, granted_at)
       VALUES ($1, $2, $3, 'zone', ARRAY['porto-novo'], now())`,
      [uuid(), SUPERVISOR, roleId],
    );
    expect(await roles.activeRoles(SUPERVISOR)).toEqual([
      {
        code: 'cleaning_planner',
        scopeType: 'zone',
        scopeId: null,
        requiresMfa: true,
        backofficeAccess: true,
        zoneKeys: ['porto-novo'],
        permissions: ['cleaning.request.read', 'cleaning.zone.manage'],
      },
    ]);
    // super_admin : toutes les permissions déclarées et non retirées.
    const [director] = await roles.activeRoles(DIRECTOR);
    expect(director?.permissions.sort()).toEqual([
      'cleaning.planning.manage',
      'cleaning.request.read',
      'cleaning.zone.manage',
    ]);
    // Personnel à prévenir (RV-62) : super_admin partout, le superviseur dans sa zone seulement.
    expect(await rbac.staffWith('cleaning.zone.manage', 'porto-novo')).toEqual([DIRECTOR, SUPERVISOR].sort());
    expect(await rbac.staffWith('cleaning.zone.manage', 'cotonou')).toEqual([DIRECTOR]);
    expect(await rbac.staffWith('cleaning.zone.manage', null)).toEqual([DIRECTOR]);
    expect(await rbac.staffWith('cleaning.unknown.read', 'porto-novo')).toEqual([]);
    expect(await rbac.accountStatus(SUPERVISOR)).toBe('active');

    // La base refuse une portée zone sans zone.
    await expect(
      pool.query(
        `INSERT INTO role_assignments (id, user_id, role_id, scope_type, granted_at) VALUES ($1, $2, $3, 'zone', now())`,
        [uuid(), SUPERVISOR, roleId],
      ),
    ).rejects.toThrow(/role_assignments_zone_keys_check/);

    await expect(rbac.deactivate({ ...write(), code: 'cleaning_planner' })).rejects.toEqual(
      new RoleInUseError(1),
    );
    await pool.query('UPDATE role_assignments SET revoked_at = now() WHERE user_id = $1', [SUPERVISOR]);
    await rbac.deactivate({ ...write(), code: 'cleaning_planner' });
    expect(await rbac.find('cleaning_planner')).toMatchObject({ active: false, deactivatedBy: DIRECTOR });
  });
});
