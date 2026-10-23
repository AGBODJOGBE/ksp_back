import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { type CleaningDeps } from '../src/application/deps';
import {
  AGENT_ID,
  asAdmin,
  asCustomer,
  asSupervisor,
  CUSTOMER_ID,
  FixedClock,
  OTHER_AGENT_ID,
} from '../src/application/testing/fakes';
import { createUseCases } from '../src/application/use-cases';
import { PrismaAgentRepository } from '../src/infrastructure/persistence/prisma-agent.repository';
import { PrismaCatalogRepository } from '../src/infrastructure/persistence/prisma-catalog.repository';
import { PrismaMissionRepository } from '../src/infrastructure/persistence/prisma-mission.repository';
import { PrismaQuoteRequestRepository } from '../src/infrastructure/persistence/prisma-quote-request.repository';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { UuidV7Generator } from '../src/infrastructure/system/system';

/**
 * Intégration contre un vrai PostgreSQL : migrations du service dans un schéma jetable, puis le
 * parcours complet avec les dépôts Prisma (idempotence, événements dans la même transaction,
 * acceptations simultanées, conflits de créneaux). Ignoré sans TEST_DATABASE_URL (fourni en CI).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const SLOT = { start: '2026-10-30T08:00:00.000Z', end: '2026-10-30T11:00:00.000Z' };

describeWithDatabase('dépôts cleaning (PostgreSQL)', () => {
  const schema = `cleaning_test_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;
  let deps: CleaningDeps;
  let useCases: ReturnType<typeof createUseCases>;

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
    deps = {
      catalog: new PrismaCatalogRepository(prisma),
      requests: new PrismaQuoteRequestRepository(prisma),
      missions: new PrismaMissionRepository(prisma),
      agents: new PrismaAgentRepository(prisma),
      clock: new FixedClock(),
      ids: new UuidV7Generator(),
    };
    useCases = createUseCases(deps);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  const outbox = async () =>
    (await pool.query('SELECT event_type FROM outbox ORDER BY created_at, id')).rows.map(
      (row) => row.event_type,
    );

  it('la migration crée les réglages par défaut et une grille vide', async () => {
    expect(await deps.catalog.getSettings()).toMatchObject({
      quoteValidityDays: 15,
      depositPercent: 30,
      maxOpenRequests: 5,
    });
    expect(await deps.catalog.listServices()).toEqual([]);
  });

  it('parcours complet : grille versionnée, demande idempotente, devis, acceptation, passage', async () => {
    const pricing = {
      unitPrice: 5000,
      minimumPrice: 15000,
      options: [],
      communeCoefficients: [],
      defaultCoefficientBp: 10000,
      teamSize: { unitsPerAgent: 3, minAgents: 1, maxAgents: 6 },
      checklist: [],
    };
    const service = {
      code: 'home_cleaning',
      name: 'Nettoyage à domicile',
      description: '',
      unit: 'room',
      active: true,
    };
    await asAdmin(() =>
      useCases.saveService.execute({ ...service, pricing: { ...pricing, unitPrice: 4000 } }),
    );
    const saved = await asAdmin(() => useCases.saveService.execute({ ...service, pricing }));
    expect(saved.pricing).toMatchObject({ version: 2, unitPrice: 5000 });
    await asAdmin(() => useCases.registerAgent.execute({ agentId: AGENT_ID, displayName: 'Awa' }));
    await asAdmin(() => useCases.registerAgent.execute({ agentId: OTHER_AGENT_ID, displayName: 'Koffi' }));

    const input = {
      idempotencyKey: 'int-1',
      serviceCode: 'home_cleaning',
      premisesType: 'house',
      quantity: 4,
      options: [],
      commune: 'Cotonou',
      address: 'Lot 12, Cotonou',
      preferredSlots: [SLOT],
      comment: '',
      requestedTeamSize: 0,
    };
    // Deux appels simultanés avec la même clé : une seule demande, un seul événement.
    const [a, b] = await Promise.all([
      asCustomer(() => useCases.requestQuote.execute(input)),
      asCustomer(() => useCases.requestQuote.execute(input)),
    ]);
    expect(a.id).toBe(b.id);
    expect((await pool.query('SELECT count(*)::int AS n FROM quote_requests')).rows[0].n).toBe(1);
    expect(await outbox()).toEqual(['cleaning.quote.requested']);
    const { rows } = await pool.query('SELECT payload FROM outbox');
    expect(JSON.stringify(rows)).not.toContain('Lot 12');

    await asSupervisor(() =>
      useCases.sendQuote.execute({
        requestId: a.id,
        lines: [],
        proposedSlots: [SLOT],
        validityDays: 0,
        teamSize: 0,
        durationMinutes: 180,
      }),
    );
    const accept = (key: string) =>
      asCustomer(() =>
        useCases.acceptQuote.execute({
          requestId: a.id,
          idempotencyKey: key,
          slotStart: SLOT.start,
          paymentPlan: { option: 'deposit', timing: 'before', method: 'cash' },
        }),
      );
    // Acceptations simultanées avec deux clés : une seule mission.
    const results = await Promise.allSettled([accept('acc-1'), accept('acc-2')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM missions')).rows[0].n).toBe(1);
    const missionId = (await pool.query('SELECT id FROM missions')).rows[0].id as string;

    const schedule = (start: string, agentId: string) =>
      asSupervisor(() =>
        useCases.scheduleIntervention.execute({
          missionId,
          scheduledStart: start,
          durationMinutes: 180,
          agentIds: [agentId],
          teamId: '',
        }),
      );
    const view = await schedule('2026-10-30T08:00:00Z', AGENT_ID);
    expect(view.mission).toMatchObject({
      status: 'scheduled',
      payment: { total: 20000, depositAmount: 6000 },
    });
    await asSupervisor(() =>
      useCases.recordPayment.execute({ missionId, amount: 6000, method: 'cash', reference: 'reçu 12' }),
    );
    expect((await deps.missions.findById(missionId))!.payment.payments).toHaveLength(1);
    expect(await deps.missions.pendingForCustomer(CUSTOMER_ID)).toEqual([
      { id: missionId, status: 'scheduled' },
    ]);
    expect(await outbox()).toEqual([
      'cleaning.quote.requested',
      'cleaning.quote.sent',
      'cleaning.booking.confirmed',
      'cleaning.mission.scheduled',
    ]);
    const audit = (await pool.query('SELECT action FROM audit_log ORDER BY at, id')).rows.map(
      (r) => r.action,
    );
    expect(audit).toEqual(
      expect.arrayContaining(['service.saved', 'quote.sent', 'quote.accepted', 'payment.recorded']),
    );
  });

  it('agent déjà pris : aucun passage enregistré, aucun événement', async () => {
    const before = await outbox();
    const missions = await deps.missions.list({}, { limit: 1, cursor: null });
    const mission = missions.items[0]!;
    // Mission fictive pour le même agent, au même moment.
    const other = {
      ...mission,
      id: '0192f1c4-0000-7000-8000-0000000000aa',
      requestId: '0192f1c4-0000-7000-8000-0000000000ab',
      interventions: [],
      version: 0,
    };
    await prisma.mission.create({
      data: {
        id: other.id,
        requestId: other.requestId,
        quoteId: other.quoteId,
        acceptanceKey: 'x',
        customerId: other.customerId,
        status: 'to_schedule',
        serviceCode: other.serviceCode,
        commune: other.commune,
        address: other.address,
        chosenSlotStart: other.chosenSlot.start,
        chosenSlotEnd: other.chosenSlot.end,
        plannedInterventions: 1,
        paymentPlan: { option: 'deposit', timing: 'before', method: 'cash' },
        paymentTotal: other.payment.total,
        depositPercent: 30,
        depositAmount: other.payment.depositAmount,
        createdAt: other.createdAt,
        updatedAt: other.updatedAt,
      },
    });
    const result = asSupervisor(() =>
      useCases.scheduleIntervention.execute({
        missionId: other.id,
        scheduledStart: '2026-10-30T10:00:00Z',
        durationMinutes: 60,
        agentIds: [AGENT_ID],
        teamId: '',
      }),
    );
    await expect(result).rejects.toMatchObject({
      code: 'CLEANING_TEAM_UNAVAILABLE',
      details: { agentIds: [AGENT_ID] },
    });
    expect(await outbox()).toEqual(before);
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM interventions WHERE mission_id = $1', [other.id]))
        .rows[0].n,
    ).toBe(0);
  });
});
