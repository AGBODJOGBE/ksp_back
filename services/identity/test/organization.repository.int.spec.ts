import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { VerificationAlreadyConsumedError } from '../src/application/email/email.ports';
import {
  OrganizationChangedError,
  OrganizationIfuTakenError,
} from '../src/application/organization/organization.ports';
import { EmailAddress } from '../src/domain/user/email-address';
import { PrismaEmailVerificationRepository } from '../src/infrastructure/email/prisma-email-verification.repository';
import { PrismaOrganizationRepository } from '../src/infrastructure/organization/prisma-organization.repository';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { PrismaSessionStore } from '../src/infrastructure/session/prisma-session.store';

/**
 * Test d'intégration contre un vrai PostgreSQL : organisations (IFU unique hors refus, membre
 * administrateur), décisions du back-office (transition conditionnelle, événement, audit), e-mail de
 * facturation et organisation active d'une session (ADR-027).
 * Ignoré si TEST_DATABASE_URL n'est pas défini (la CI le fournit).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const CLIENT = '0192f1c4-7a2b-7c3d-8e4f-000000000001';
const STAFF = '0192f1c4-7a2b-7c3d-8e4f-000000000002';
const SESSION = '0192f1c4-7a2b-7c3d-8e4f-0000000005e1';

describeWithDatabase('PrismaOrganizationRepository (PostgreSQL)', () => {
  const schema = `identity_org_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;
  let organizations: PrismaOrganizationRepository;
  let verifications: PrismaEmailVerificationRepository;
  let sessions: PrismaSessionStore;
  let seq = 100;
  const uuid = () => `0192f1c4-7a2b-7c3d-8e4f-${String(++seq).padStart(12, '0')}`;
  const now = new Date('2026-10-27T10:00:00Z');

  const create = (ifu = '3201912345678') =>
    organizations.create({
      id: uuid(),
      legalName: 'SARL Bénin Propre',
      address: 'Haie Vive, Cotonou',
      ifu,
      rccm: null,
      createdBy: CLIENT,
      memberId: uuid(),
      now,
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
    organizations = new PrismaOrganizationRepository(prisma);
    verifications = new PrismaEmailVerificationRepository(prisma);
    sessions = new PrismaSessionStore(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE email_verifications, organization_members, organizations, sessions, users CASCADE',
    );
    await pool.query('TRUNCATE outbox, audit_log');
    for (const id of [CLIENT, STAFF]) {
      await pool.query(
        `INSERT INTO users (id, status, first_name, updated_at) VALUES ($1, 'active', 'Koffi', now())`,
        [id],
      );
    }
  });

  it('crée l’organisation en attente avec son administrateur, et les deux événements', async () => {
    const created = await create();
    expect(created).toMatchObject({
      role: 'org_admin',
      organization: { status: 'pending_review', rccm: null },
    });
    const outbox = await pool.query('SELECT event_type, payload FROM outbox ORDER BY created_at, id');
    expect(outbox.rows.map((row) => row.event_type).sort()).toEqual([
      'identity.member.added',
      'identity.organization.created',
    ]);
    await expect(organizations.membership(CLIENT, created.organization.id)).resolves.toMatchObject({
      role: 'org_admin',
    });
    await expect(organizations.memberships(CLIENT)).resolves.toHaveLength(1);
    await expect(organizations.countPendingCreatedBy(CLIENT)).resolves.toBe(1);
    await expect(organizations.members(created.organization.id)).resolves.toEqual([
      expect.objectContaining({ userId: CLIENT, firstName: 'Koffi', phoneE164: null }),
    ]);
  });

  it('un IFU n’appartient qu’à une organisation non refusée', async () => {
    const first = await create();
    await expect(create()).rejects.toBeInstanceOf(OrganizationIfuTakenError);
    await organizations.applyDecision({
      organizationId: first.organization.id,
      decision: 'reject',
      from: 'pending_review',
      to: 'rejected',
      actorId: STAFF,
      reason: 'IFU inconnu',
      auditId: uuid(),
      now,
    });
    await expect(create()).resolves.toMatchObject({ organization: { status: 'pending_review' } });
  });

  it('décision conditionnelle : événement et trace d’audit dans la même transaction', async () => {
    const { organization } = await create();
    const change = {
      organizationId: organization.id,
      decision: 'validate' as const,
      from: 'pending_review' as const,
      to: 'active' as const,
      actorId: STAFF,
      reason: null,
      auditId: uuid(),
      now,
    };
    await expect(organizations.applyDecision(change)).resolves.toMatchObject({
      status: 'active',
      reviewedBy: STAFF,
    });
    await expect(organizations.applyDecision({ ...change, auditId: uuid() })).rejects.toBeInstanceOf(
      OrganizationChangedError,
    );
    const audit = await pool.query('SELECT actor_id, action, entity_id FROM audit_log');
    expect(audit.rows).toEqual([
      { actor_id: STAFF, action: 'organization.validated', entity_id: organization.id },
    ]);
    const events = await pool.query(
      "SELECT payload FROM outbox WHERE event_type = 'identity.organization.validated'",
    );
    expect(events.rows[0].payload.payload).toEqual({
      organizationId: organization.id,
      legalName: 'SARL Bénin Propre',
      createdBy: CLIENT,
      validatedBy: STAFF,
    });
    const page = await organizations.list({ status: 'active' }, { limit: 10, cursor: null });
    expect(page).toMatchObject({ items: [{ id: organization.id }], nextCursor: null });
  });

  it('e-mail de facturation : demande propre à l’organisation, confirmée une seule fois', async () => {
    const { organization } = await create();
    const id = uuid();
    await verifications.create({
      id,
      userId: CLIENT,
      organizationId: organization.id,
      email: EmailAddress.parse('compta@beninpropre.bj')!,
      codeHash: 'empreinte',
      expiresAt: new Date(now.getTime() + 900_000),
      ip: null,
      createdAt: now,
    });
    await expect(verifications.findLatest(CLIENT)).resolves.toBeNull();
    await expect(verifications.findLatestForOrganization(organization.id)).resolves.toMatchObject({ id });
    const confirmation = {
      verificationId: id,
      organizationId: organization.id,
      email: 'compta@beninpropre.bj',
      now,
    };
    await verifications.confirmForOrganization(confirmation);
    await expect(verifications.confirmForOrganization(confirmation)).rejects.toBeInstanceOf(
      VerificationAlreadyConsumedError,
    );
    await expect(organizations.findById(organization.id)).resolves.toMatchObject({
      billingEmail: 'compta@beninpropre.bj',
    });
    await expect(organizations.findByIds([organization.id, uuid()])).resolves.toEqual([
      expect.objectContaining({ id: organization.id, billingEmail: 'compta@beninpropre.bj' }),
    ]);
  });

  it('fiches lues par les autres services : adresse non vérifiée jamais transmise', async () => {
    const { organization } = await create();
    // Seconde barrière : une adresse sans date de vérification n'est pas rendue.
    await pool.query("UPDATE organizations SET billing_email = 'compta@beninpropre.bj' WHERE id = $1", [
      organization.id,
    ]);
    await expect(organizations.findByIds([organization.id])).resolves.toEqual([
      expect.objectContaining({ id: organization.id, ifu: '3201912345678', billingEmail: null }),
    ]);
  });

  it('suspension et réactivation : le demandeur figure dans l’événement', async () => {
    const { organization } = await create();
    const decide = (
      decision: 'validate' | 'suspend' | 'reactivate',
      from: 'pending_review' | 'active' | 'suspended',
      to: 'active' | 'suspended',
      reason: string | null,
    ) =>
      organizations.applyDecision({
        organizationId: organization.id,
        decision,
        from,
        to,
        actorId: STAFF,
        reason,
        auditId: uuid(),
        now,
      });
    await decide('validate', 'pending_review', 'active', null);
    await decide('suspend', 'active', 'suspended', 'Usurpation signalée');
    await decide('reactivate', 'suspended', 'active', null);
    const events = await pool.query(
      "SELECT event_type, payload FROM outbox WHERE event_type IN ('identity.organization.suspended', 'identity.organization.reactivated') ORDER BY event_type",
    );
    expect(events.rows.map((row) => [row.event_type, row.payload.payload])).toEqual([
      [
        'identity.organization.reactivated',
        {
          organizationId: organization.id,
          legalName: 'SARL Bénin Propre',
          reactivatedBy: STAFF,
          createdBy: CLIENT,
        },
      ],
      [
        'identity.organization.suspended',
        {
          organizationId: organization.id,
          legalName: 'SARL Bénin Propre',
          suspendedBy: STAFF,
          createdBy: CLIENT,
          reason: 'Usurpation signalée',
        },
      ],
    ]);
  });

  it('organisation active d’une session : changée tant que la session est ouverte', async () => {
    const { organization } = await create();
    await pool.query(
      `INSERT INTO sessions (id, user_id, client_kind, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, 'web', now(), now(), now() + interval '30 days')`,
      [SESSION, CLIENT],
    );
    await expect(sessions.setActiveOrganization(SESSION, CLIENT, organization.id)).resolves.toBe(true);
    await expect(sessions.findSession(SESSION)).resolves.toMatchObject({ userId: CLIENT, clientKind: 'web' });
    await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [SESSION]);
    await expect(sessions.setActiveOrganization(SESSION, CLIENT, null)).resolves.toBe(false);
    const row = await pool.query('SELECT active_org_id FROM sessions WHERE id = $1', [SESSION]);
    expect(row.rows[0].active_org_id).toBe(organization.id);
  });
});
