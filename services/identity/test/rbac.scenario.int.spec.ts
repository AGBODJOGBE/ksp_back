import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadinessRegistry, type RequestContext, runWithContext } from '@ksp/platform';
import { Client, Pool } from 'pg';
import {
  AccountDetails,
  GrantAccountRoleUseCase,
  RevokeAccountRoleUseCase,
} from '../src/application/account-admin/account-admin.use-cases';
import { RegisterCatalogUseCase } from '../src/application/rbac/catalog.use-cases';
import { CreateRoleUseCase } from '../src/application/rbac/managed-roles.use-cases';
import { backofficeGrants } from '../src/application/role/role-claims';
import { AccessTokenIssuer } from '../src/application/token/access-token-issuer';
import { type TokenSigner } from '../src/application/token/token.ports';
import { PrismaAccountAdminRepository } from '../src/infrastructure/account-admin/prisma-account-admin.repository';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { PrismaRbacRepository } from '../src/infrastructure/rbac/prisma-rbac.repository';
import { PrismaRoleRepository } from '../src/infrastructure/role/prisma-role.repository';

/**
 * Critère du lot B (CDC Nettoyage v2, partie 18) côté identity, contre un vrai PostgreSQL : un super
 * administrateur crée un rôle, l'assigne, et le jeton de la personne porte exactement les
 * permissions cochées (perms), limitées à sa zone quand l'attribution l'est (zone_perms). Le retrait
 * d'un rôle sensible ferme aussitôt ses sessions (R-RB-05).
 * Ignoré si TEST_DATABASE_URL n'est pas défini (la CI le fournit).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const DIRECTOR = '0192f1c4-7a2b-7c3d-8e4f-00000000bd01';
const PLANNER = '0192f1c4-7a2b-7c3d-8e4f-00000000bd02';
const SUPER_ADMIN_ROLE_ID = '019a0000-0000-7000-8000-000000000001';

/** Signataire factice : garde les revendications du jeton émis. */
class CapturingSigner {
  readonly signed: Record<string, unknown>[] = [];
  async sign(claims: Record<string, unknown>): Promise<string> {
    this.signed.push(claims);
    return 'jeton';
  }
}

describeWithDatabase('RBAC dynamique de bout en bout (PostgreSQL)', () => {
  const schema = `identity_rbac_scenario_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;
  let seq = 500;
  const ids = { next: () => `0192f1c4-7a2b-7c3d-8e4f-${String(++seq).padStart(12, '0')}` };
  const clock = { now: () => new Date() };

  /** Appel du super administrateur, double authentification faite maintenant. */
  const asDirector = <T>(fn: () => Promise<T>): Promise<T> => {
    const context: RequestContext = {
      correlationId: 'c',
      user: {
        userId: DIRECTOR,
        sessionId: 's',
        activeContext: 'personal',
        roles: [{ role: 'super_admin', scopeType: 'global' }],
        mfa: true,
        authTime: Math.floor(Date.now() / 1000),
      },
    };
    return runWithContext(context, fn);
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
    process.env.DATABASE_URL = url.toString();
    prisma = new PrismaService(new ReadinessRegistry());
    await prisma.$connect();
    for (const id of [DIRECTOR, PLANNER]) {
      await pool.query(
        `INSERT INTO users (id, status, first_name, last_name, updated_at) VALUES ($1, 'active', 'A', 'B', now())`,
        [id],
      );
    }
    await pool.query(
      `INSERT INTO role_assignments (id, user_id, role_id, scope_type, granted_at) VALUES ($1, $2, $3, 'global', now())`,
      [ids.next(), DIRECTOR, SUPER_ADMIN_ROLE_ID],
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  it('rôle créé, assigné dans une zone : le jeton porte exactement ses permissions', async () => {
    const rbac = new PrismaRbacRepository(prisma);
    const roles = new PrismaRoleRepository(prisma);
    const accounts = new PrismaAccountAdminRepository(prisma);
    const details = new AccountDetails(accounts);

    // Le service cleaning déclare ses permissions à son déploiement (R-RB-01).
    await new RegisterCatalogUseCase(rbac, ids, clock).execute('cleaning', {
      service: 'cleaning',
      version: 1,
      permissions: [
        'cleaning.catalog.read',
        'cleaning.catalog.manage',
        'cleaning.request.read',
        'cleaning.request.process',
        'cleaning.planning.manage',
      ].map((code) => ({ code, description: code })),
      roles: [],
    });

    // Le super administrateur crée deux rôles et les assigne, l'un limité à Porto-Novo.
    const create = new CreateRoleUseCase(rbac, ids, clock);
    await asDirector(() =>
      create.execute({
        code: 'cleaning_reader',
        name: 'Lecteur Nettoyage',
        description: '',
        permissions: ['cleaning.catalog.read', 'cleaning.request.read'],
        sensitive: false,
        reason: 'Lecture du catalogue et des demandes',
      }),
    );
    await asDirector(() =>
      create.execute({
        code: 'cleaning_planner',
        name: 'Planificateur Nettoyage',
        description: '',
        permissions: ['cleaning.planning.manage', 'cleaning.request.process'],
        sensitive: true,
        reason: 'Planification de Porto-Novo',
      }),
    );
    const grant = new GrantAccountRoleUseCase(details, roles, ids, clock);
    await asDirector(() =>
      grant.execute({ userId: PLANNER, roleCode: 'cleaning_reader', reason: 'Arrivée' }),
    );
    const detail = await asDirector(() =>
      grant.execute({
        userId: PLANNER,
        roleCode: 'cleaning_planner',
        reason: 'Superviseur de Porto-Novo',
        zoneKeys: ['porto-novo'],
      }),
    );
    expect(detail.roles.find((role) => role.role.code === 'cleaning_planner')).toMatchObject({
      scopeType: 'zone',
      zoneKeys: ['porto-novo'],
    });

    // Jeton émis à la connexion ou au renouvellement : mêmes revendications.
    const signer = new CapturingSigner();
    const issuer = new AccessTokenIssuer(signer as unknown as TokenSigner, ids, clock, 900);
    await issuer.issue({
      userId: PLANNER,
      sessionId: ids.next(),
      clientId: 'backoffice',
      activeContext: 'personal',
      ...backofficeGrants(await roles.activeRoles(PLANNER)),
      mfa: true,
      authTime: new Date(),
      amr: ['otp', 'mfa'],
    });
    expect(signer.signed[0]).toMatchObject({
      roles: [
        { role: 'customer', scopeType: 'personal' },
        { role: 'cleaning_reader', scopeType: 'global', scopeId: null },
        { role: 'cleaning_planner', scopeType: 'zone', scopeId: null, zoneKeys: ['porto-novo'] },
      ],
      perms: ['cleaning.catalog.read', 'cleaning.request.read'],
      zone_perms: { 'porto-novo': ['cleaning.planning.manage', 'cleaning.request.process'] },
    });

    // Événement identity.role.granted en version 2, avec les zones.
    const granted = await pool.query(
      `SELECT payload FROM outbox WHERE event_type = 'identity.role.granted' ORDER BY created_at DESC, id DESC LIMIT 1`,
    );
    expect(granted.rows[0].payload).toMatchObject({
      version: 2,
      payload: { userId: PLANNER, roleCode: 'cleaning_planner', scopeType: 'zone', zoneKeys: ['porto-novo'] },
    });

    // Retrait du rôle sensible : toutes ses sessions fermées immédiatement (R-RB-05).
    const sessionId = ids.next();
    await pool.query(
      `INSERT INTO sessions (id, user_id, client_kind, created_at, expires_at, last_seen_at)
       VALUES ($1, $2, 'backoffice', now(), now() + interval '1 hour', now())`,
      [sessionId, PLANNER],
    );
    const planner = detail.roles.find((role) => role.role.code === 'cleaning_planner')!;
    await asDirector(() =>
      new RevokeAccountRoleUseCase(details, accounts, roles, ids, clock).execute({
        userId: PLANNER,
        assignmentId: planner.id,
        reason: 'Départ de Porto-Novo',
      }),
    );
    const session = await pool.query('SELECT revoked_at, revoke_reason FROM sessions WHERE id = $1', [
      sessionId,
    ]);
    expect(session.rows[0]).toMatchObject({ revoke_reason: 'sensitive_role_revoked' });
    expect(session.rows[0].revoked_at).not.toBeNull();
    const revoked = await pool.query(
      `SELECT payload FROM outbox WHERE event_type = 'identity.role.revoked' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(revoked.rows[0].payload.payload).toMatchObject({
      roleCode: 'cleaning_planner',
      sessionsRevoked: true,
    });
  });
});
