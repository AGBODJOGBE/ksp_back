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
  definitionInput,
  FakeGeocoder,
  FixedClock,
  OTHER_AGENT_ID,
} from '../src/application/testing/fakes';
import { createUseCases } from '../src/application/use-cases';
import { type RequestQuoteGroupInput } from '../src/application/places/request-groups.use-cases';
import { definitionProblems, isFullyPriced } from '../src/domain/catalog';
import { DEFAULT_FIELD_DATE_POLICY } from '../src/domain/schedule';
import { homeCleaningService } from '../src/domain/testing';
import { PrismaAgentRepository } from '../src/infrastructure/persistence/prisma-agent.repository';
import { PrismaCatalogRepository } from '../src/infrastructure/persistence/prisma-catalog.repository';
import { PrismaContractInvoiceRepository } from '../src/infrastructure/persistence/prisma-contract-invoice.repository';
import { PrismaMissionRepository } from '../src/infrastructure/persistence/prisma-mission.repository';
import {
  lockOrganizationStanding,
  PrismaOrganizationStandingRepository,
} from '../src/infrastructure/persistence/prisma-organization-standing.repository';
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
  const clock = new FixedClock();

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
      invoices: new PrismaContractInvoiceRepository(prisma),
      organizations: new PrismaOrganizationStandingRepository(prisma),
      geocoder: new FakeGeocoder(),
      people: { userNames: async () => new Map(), organizationNames: async () => new Map() },
      fieldDates: { ...DEFAULT_FIELD_DATE_POLICY },
      clock,
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

  it('les migrations créent les réglages, les huit prestations (prix à null) et les types de lieu (ADR-033, 034)', async () => {
    expect(await deps.catalog.getSettings()).toMatchObject({
      quoteValidityDays: 15,
      depositPercent: 30,
      maxOpenRequests: 5,
    });
    const services = await deps.catalog.listServices();
    expect(
      services.map((service) => [service.code, service.unit, service.active, service.pricing.version]),
    ).toEqual([
      ['garden_maintenance', 'square_meter', true, 1],
      ['home_cleaning', 'room', true, 1],
      ['house_cleaning', 'room', true, 1],
      ['office_cleaning', 'square_meter', true, 1],
      ['pest_control', 'square_meter', true, 1],
      ['post_construction', 'square_meter', true, 1],
      ['septic_emptying', 'cubic_meter', true, 1],
      ['window_cleaning', 'square_meter', true, 1],
    ]);
    const house = services.find((service) => service.code === 'house_cleaning')!;
    expect(house.fields.map((field) => [field.code, field.required])).toEqual([
      ['surface', true],
      ['bedrooms', true],
      ['bathrooms', true],
      ['front_yard', true],
      ['back_yard', true],
      ['condition', true],
      ['pets', false],
    ]);
    expect(house.pricing.teamSize).toEqual({
      fieldCode: 'bedrooms',
      unitsPerAgent: 3,
      minAgents: 1,
      maxAgents: 6,
    });
    expect(house.options.map((option) => option.code)).toEqual(['windows']);
    const windows = services.find((service) => service.code === 'window_cleaning')!;
    expect(windows.pricing.teamSize).toEqual({
      fieldCode: 'window_count',
      unitsPerAgent: 20,
      minAgents: 1,
      maxAgents: 4,
    });
    expect((await deps.catalog.listPlaceTypes()).map((p) => [p.code, p.icon, p.serviceCodes])).toEqual([
      [
        'house',
        'house',
        ['house_cleaning', 'garden_maintenance', 'window_cleaning', 'septic_emptying', 'pest_control'],
      ],
      [
        'villa',
        'villa',
        ['house_cleaning', 'garden_maintenance', 'window_cleaning', 'septic_emptying', 'pest_control'],
      ],
      ['apartment', 'apartment', ['home_cleaning', 'window_cleaning', 'pest_control']],
      ['office', 'office', ['office_cleaning', 'window_cleaning', 'pest_control', 'septic_emptying']],
      ['construction_site', 'construction', ['post_construction', 'window_cleaning']],
    ]);
    for (const service of services) {
      // Chaque définition de départ est valide et n'a aucun prix.
      expect(definitionProblems(service)).toEqual([]);
      expect(isFullyPriced(service)).toBe(false);
      expect(service.options.every((option) => option.flatPrice === null)).toBe(true);
      expect(service.pricing.minimumPrice).toBeNull();
    }
    const septic = services.find((service) => service.code === 'septic_emptying')!;
    expect(septic.fields.map((field) => field.code)).toEqual(['tank_volume', 'tank_type', 'truck_access']);
    expect(septic.pricing.frequencies.map((frequency) => frequency.code)).toEqual(['once']);
    expect(septic.pricing.teamSize.fieldCode).toBe('tank_volume');
    const garden = services.find((service) => service.code === 'garden_maintenance')!;
    expect(garden.pricing.frequencies.map((frequency) => [frequency.code, frequency.coefficientBp])).toEqual([
      ['once', 10000],
      ['weekly', 10000],
      ['monthly', 10000],
    ]);
    expect((await deps.catalog.listZones()).map((zone) => zone.code)).toEqual([
      'abomey-calavi',
      'cotonou',
      'porto-novo',
    ]);
  });

  it('parcours complet : grille versionnée, demande idempotente, devis, acceptation, passage', async () => {
    const definition = (roomPrice: number) => {
      const service = homeCleaningService({
        pricing: { ...homeCleaningService().pricing, communeCoefficients: {} },
      });
      service.fields[1]!.pricePerUnit = roomPrice;
      return definitionInput(service);
    };
    await asAdmin(() => useCases.saveService.execute('home_cleaning', definition(4000)));
    const saved = await asAdmin(() => useCases.saveService.execute('home_cleaning', definition(5000)));
    expect(saved.pricing).toMatchObject({ version: 3, minimumPrice: 15000 });
    expect(saved.fields[1]).toMatchObject({ code: 'rooms', pricePerUnit: 5000 });
    expect(saved.options.map((option) => option.code)).toEqual(['windows', 'sofa', 'appliances']);
    // Anciennes colonnes déduites, pour les anciens lecteurs.
    const legacy = await pool.query(
      "SELECT unit_price, options FROM pricing_rules WHERE service_code = 'home_cleaning' AND version = 3",
    );
    expect(legacy.rows[0]).toMatchObject({ unit_price: 5000 });
    expect(legacy.rows[0].options).toEqual([
      { code: 'windows', label: 'Vitres', price: null },
      { code: 'sofa', label: 'Canapé', price: null },
      { code: 'appliances', label: 'Électroménager', price: 5000 },
    ]);
    await asAdmin(() => useCases.registerAgent.execute({ agentId: AGENT_ID, displayName: 'Awa' }));
    await asAdmin(() => useCases.registerAgent.execute({ agentId: OTHER_AGENT_ID, displayName: 'Koffi' }));

    const input = {
      idempotencyKey: 'int-1',
      serviceCode: 'home_cleaning',
      answers: { housing_type: 'apartment', rooms: 4, bathrooms: 0, condition: 'normal' },
      optionSelections: [],
      frequency: 'once',
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
    // Réponses, version de grille et détail du calcul enregistrés avec la demande.
    expect(await deps.requests.findById(a.id)).toMatchObject({
      answers: input.answers,
      optionSelections: [],
      frequency: 'once',
      pricingVersion: 3,
      quantity: 4,
      calculation: { priced: true, computedPrice: 20000, pricingVersion: 3 },
    });
    expect(await outbox()).toEqual(['cleaning.quote.requested']);
    const { rows } = await pool.query('SELECT payload FROM outbox');
    expect(JSON.stringify(rows)).not.toContain('Lot 12');

    // Visite des lieux réalisée : obligatoire avant tout devis.
    const visited = await asSupervisor(() =>
      useCases.scheduleVisit.execute({
        requestId: a.id,
        scheduledAt: '2026-10-26T09:00:00Z',
        agentId: AGENT_ID,
      }),
    );
    // Le compte rendu ne s'enregistre qu'à partir de l'heure prévue de la visite (contrôle des dates).
    const scheduledNow = clock.current;
    clock.current = new Date('2026-10-26T09:30:00Z');
    await asSupervisor(() =>
      useCases.completeVisit.execute({ visitId: visited.visit!.id, report: 'Visite faite.' }),
    );
    clock.current = scheduledNow;
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
    // Paiement en ligne (ADR-031) : inbox et paiement dans la même transaction, doublon sans effet.
    const online = {
      eventId: '0192f1c4-0000-7000-8000-0000000000e1',
      eventType: 'payment.intent.succeeded',
      paymentId: '0192f1c4-0000-7000-8000-0000000000e2',
      subjectType: 'cleaning_mission',
      missionId,
      amount: 14000,
      providerReference: 'trx_1',
      succeededAt: new Date().toISOString(),
    };
    expect(await useCases.recordOnlinePayment.execute(online)).toBe('recorded');
    expect(await useCases.recordOnlinePayment.execute(online)).toBe('duplicate');
    expect(
      (await deps.missions.findById(missionId))!.payment.payments.map((payment) => payment.method),
    ).toEqual(['cash', 'mobile_money_online']);
    expect(await deps.missions.pendingForCustomer(CUSTOMER_ID)).toEqual([
      { id: missionId, status: 'scheduled' },
    ]);
    expect(await outbox()).toEqual([
      'cleaning.quote.requested',
      'cleaning.visit.scheduled',
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

  it('impayés d’entreprise : inbox idempotente, suspension, puis reprise avec reprogrammation', async () => {
    const missionId = '0192f1c4-0000-7000-8000-0000000000c1';
    const interventionId = '0192f1c4-0000-7000-8000-0000000000c2';
    await prisma.mission.create({
      data: {
        id: missionId,
        requestId: '0192f1c4-0000-7000-8000-0000000000c3',
        quoteId: '0192f1c4-0000-7000-8000-0000000000c4',
        acceptanceKey: 'b',
        customerId: CUSTOMER_ID,
        organizationId: '0192f1c4-0000-7000-8000-0000000000c5',
        status: 'scheduled',
        serviceCode: 'home_cleaning',
        commune: 'Cotonou',
        address: 'Zone industrielle',
        chosenSlotStart: new Date('2026-11-12T08:00:00Z'),
        chosenSlotEnd: new Date('2026-11-12T10:00:00Z'),
        recurrence: { period: 'week', visitsPerPeriod: 1, durationMonths: 3 },
        plannedInterventions: 13,
        paymentPlan: { option: 'full', timing: 'after', method: 'cash' },
        paymentTotal: 130000,
        depositPercent: 100,
        depositAmount: 130000,
        createdAt: new Date('2026-10-01T08:00:00Z'),
        updatedAt: new Date('2026-10-01T08:00:00Z'),
        interventions: {
          create: {
            id: interventionId,
            status: 'planned',
            scheduledStart: new Date('2026-11-12T08:00:00Z'),
            scheduledEnd: new Date('2026-11-12T10:00:00Z'),
            durationMinutes: 120,
            agentIds: [OTHER_AGENT_ID],
          },
        },
      },
    });
    const invoiceEvent = (eventId: string, invoiceId: string, status: 'overdue' | 'paid') =>
      useCases.handleInvoiceEvent.execute({
        eventId,
        eventType: `billing.invoice.${status}`,
        invoiceId,
        contractId: missionId,
        source: 'cleaning',
        status,
      });
    const invoice1 = '0192f1c4-0000-7000-8000-0000000000d1';
    const invoice2 = '0192f1c4-0000-7000-8000-0000000000d2';
    expect(await invoiceEvent('0192f1c4-0000-7000-8000-0000000000e1', invoice1, 'overdue')).toBe('warned');
    // Même événement reçu deux fois en parallèle : un seul enregistrement dans l'inbox.
    await Promise.allSettled([
      invoiceEvent('0192f1c4-0000-7000-8000-0000000000e2', invoice2, 'overdue'),
      invoiceEvent('0192f1c4-0000-7000-8000-0000000000e2', invoice2, 'overdue'),
    ]);
    expect(await deps.invoices.countOverdue(missionId)).toBe(2);
    const suspended = (await deps.missions.findById(missionId))!;
    expect(suspended.suspension).toMatchObject({ causes: ['unpaid_invoices'], unpaidCount: 2 });
    expect(suspended.interventions[0]).toMatchObject({
      status: 'cancelled',
      cancellationCause: 'suspension',
    });

    expect(await invoiceEvent('0192f1c4-0000-7000-8000-0000000000e3', invoice1, 'paid')).toBe('resumed');
    // Un « overdue » arrivé après le règlement ne ramène pas la facture en impayée.
    await invoiceEvent('0192f1c4-0000-7000-8000-0000000000e4', invoice1, 'overdue');
    expect(await deps.invoices.countOverdue(missionId)).toBe(1);
    const resumed = (await deps.missions.findById(missionId))!;
    expect(resumed.suspension).toBeNull();
    expect(resumed.interventions.filter((i) => i.status === 'planned')).toHaveLength(1);
    const events = await outbox();
    expect(events.filter((type) => type.startsWith('cleaning.contract.'))).toEqual([
      'cleaning.contract.suspension_warning',
      'cleaning.contract.suspended',
      'cleaning.contract.resumed',
    ]);
    const { rows } = await pool.query(
      "SELECT payload FROM outbox WHERE event_type LIKE 'cleaning.contract.%'",
    );
    expect(JSON.stringify(rows)).not.toContain('Zone industrielle');
    expect(await deps.missions.listIndividualRecurring()).toEqual([]);
  });

  it('organisation suspendue : inbox, ordre des décisions, causes cumulées enregistrées (ADR-030)', async () => {
    const organizationId = '0192f1c4-0000-7000-8000-0000000000f0';
    const missionId = '0192f1c4-0000-7000-8000-0000000000f1';
    const legacyId = '0192f1c4-0000-7000-8000-0000000000f2';
    const columns = {
      customerId: CUSTOMER_ID,
      status: 'scheduled',
      serviceCode: 'home_cleaning',
      commune: 'Cotonou',
      address: 'Akpakpa',
      chosenSlotStart: new Date('2026-11-12T08:00:00Z'),
      chosenSlotEnd: new Date('2026-11-12T10:00:00Z'),
      recurrence: { period: 'week', visitsPerPeriod: 1, durationMonths: 3 },
      plannedInterventions: 13,
      paymentPlan: { option: 'full', timing: 'after', method: 'cash' },
      paymentTotal: 130000,
      depositPercent: 100,
      depositAmount: 130000,
      createdAt: new Date('2026-10-01T08:00:00Z'),
      updatedAt: new Date('2026-10-01T08:00:00Z'),
    };
    await prisma.mission.create({
      data: {
        ...columns,
        id: missionId,
        requestId: '0192f1c4-0000-7000-8000-0000000000f3',
        quoteId: '0192f1c4-0000-7000-8000-0000000000f4',
        acceptanceKey: 'o',
        organizationId,
        interventions: {
          create: {
            id: '0192f1c4-0000-7000-8000-0000000000f5',
            status: 'planned',
            scheduledStart: new Date('2026-11-19T08:00:00Z'),
            scheduledEnd: new Date('2026-11-19T10:00:00Z'),
            durationMinutes: 120,
            agentIds: [OTHER_AGENT_ID],
          },
        },
      },
    });
    // Suspension écrite avant la migration 0005 : une cause, sans la liste.
    await pool.query(
      'INSERT INTO missions (id, request_id, quote_id, acceptance_key, customer_id, organization_id, status, ' +
        'service_code, commune, address, chosen_slot_start, chosen_slot_end, planned_interventions, ' +
        'payment_plan, payment_total, deposit_percent, deposit_amount, suspension_cause, suspended_since, ' +
        'suspension_unpaid_count, suspension_causes, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, ' +
        "$6, 'to_schedule', 'home_cleaning', 'Cotonou', 'Akpakpa', now(), now(), 4, '{}', 40000, 100, " +
        "40000, 'unpaid_invoices', now(), 2, DEFAULT, now(), now())",
      [
        legacyId,
        '0192f1c4-0000-7000-8000-0000000000f6',
        '0192f1c4-0000-7000-8000-0000000000f7',
        'l',
        CUSTOMER_ID,
        '0192f1c4-0000-7000-8000-0000000000f8',
      ],
    );
    expect((await deps.missions.findById(legacyId))!.suspension?.causes).toEqual(['unpaid_invoices']);

    const decision = (eventId: string, suspended: boolean, occurredAt: string) =>
      useCases.handleOrganizationEvent.execute({
        eventId,
        eventType: suspended ? 'identity.organization.suspended' : 'identity.organization.reactivated',
        organizationId,
        suspended,
        occurredAt,
      });
    // Même événement reçu deux fois en parallèle : un seul enregistrement, une seule suspension.
    const twice = await Promise.allSettled([
      decision('0192f1c4-0000-7000-8000-0000000000a1', true, '2026-10-23T07:30:00Z'),
      decision('0192f1c4-0000-7000-8000-0000000000a1', true, '2026-10-23T07:30:00Z'),
    ]);
    // Au moins un traitement aboutit ; l'autre peut buter sur l'écriture concurrente (message retraité).
    expect(twice.some((outcome) => outcome.status === 'fulfilled')).toBe(true);
    expect(await deps.organizations.isSuspended(organizationId)).toBe(true);
    expect(await prisma.$transaction((tx) => lockOrganizationStanding(tx, organizationId))).toBe(true);
    const suspended = (await deps.missions.findById(missionId))!;
    expect(suspended.suspension).toMatchObject({ causes: ['organization_suspended'], unpaidCount: 0 });
    expect(suspended.interventions[0]).toMatchObject({
      status: 'cancelled',
      cancellationCause: 'suspension',
    });

    // Réactivation antérieure à la suspension (arrivée en retard) : sans effet.
    expect(await decision('0192f1c4-0000-7000-8000-0000000000a2', false, '2026-10-23T07:10:00Z')).toEqual({
      examined: 1,
      changed: 0,
    });
    // Deux factures impayées pendant la suspension : la cause s'ajoute, sans nouvelle annonce.
    for (const [eventId, invoiceId] of [
      ['0192f1c4-0000-7000-8000-0000000000a3', '0192f1c4-0000-7000-8000-0000000000b1'],
      ['0192f1c4-0000-7000-8000-0000000000a4', '0192f1c4-0000-7000-8000-0000000000b2'],
    ] as const) {
      await useCases.handleInvoiceEvent.execute({
        eventId,
        eventType: 'billing.invoice.overdue',
        invoiceId,
        contractId: missionId,
        source: 'cleaning',
        status: 'overdue',
      });
    }
    const both = await pool.query('SELECT suspension_cause, suspension_causes FROM missions WHERE id = $1', [
      missionId,
    ]);
    expect(both.rows[0]).toEqual({
      suspension_cause: 'organization_suspended',
      suspension_causes: ['organization_suspended', 'unpaid_invoices'],
    });

    // Réactivation : la mission reste suspendue pour impayés.
    expect(await decision('0192f1c4-0000-7000-8000-0000000000a5', false, '2026-10-23T08:00:00Z')).toEqual({
      examined: 1,
      changed: 1,
    });
    expect((await deps.missions.findById(missionId))!.suspension?.causes).toEqual(['unpaid_invoices']);
    // L'enveloppe entière est écrite dans l'outbox : le contenu de l'événement est sous `payload`.
    const announced = async () =>
      (
        await pool.query(
          "SELECT event_type, payload->'payload' AS body FROM outbox " +
            "WHERE payload->'payload'->>'missionId' = $1 AND event_type LIKE 'cleaning.contract.%' " +
            'ORDER BY created_at, id',
          [missionId],
        )
      ).rows as { event_type: string; body: Record<string, unknown> }[];
    // Début de la suspension annoncé une fois ; chaque changement de cause l'est ensuite à part.
    expect((await announced()).map((row) => row.event_type)).toEqual([
      'cleaning.contract.suspended',
      'cleaning.contract.suspension_updated',
      'cleaning.contract.suspension_updated',
    ]);
    expect(
      (await announced()).map((row) => [row.body['change'], row.body['cause'], row.body['causes']]),
    ).toEqual([
      [undefined, 'organization_suspended', undefined],
      ['cause_added', 'unpaid_invoices', ['organization_suspended', 'unpaid_invoices']],
      ['cause_lifted', 'organization_suspended', ['unpaid_invoices']],
    ]);
    expect((await announced())[0]!.body).toMatchObject({
      cause: 'organization_suspended',
      organizationId,
      unpaidCount: 0,
    });

    // Règlement des deux factures : dernière cause levée, reprise annoncée et passage reprogrammé.
    for (const [eventId, invoiceId] of [
      ['0192f1c4-0000-7000-8000-0000000000a6', '0192f1c4-0000-7000-8000-0000000000b1'],
      ['0192f1c4-0000-7000-8000-0000000000a7', '0192f1c4-0000-7000-8000-0000000000b2'],
    ] as const) {
      await useCases.handleInvoiceEvent.execute({
        eventId,
        eventType: 'billing.invoice.paid',
        invoiceId,
        contractId: missionId,
        source: 'cleaning',
        status: 'paid',
      });
    }
    const resumed = (await deps.missions.findById(missionId))!;
    expect(resumed.suspension).toBeNull();
    expect(resumed.interventions.filter((i) => i.status === 'planned')).toHaveLength(1);
    const cleared = await pool.query(
      'SELECT suspension_cause, suspension_causes FROM missions WHERE id = $1',
      [missionId],
    );
    expect(cleared.rows[0]).toEqual({ suspension_cause: null, suspension_causes: [] });
    expect((await announced()).map((row) => [row.event_type, row.body['cause']])).toEqual([
      ['cleaning.contract.suspended', 'organization_suspended'],
      ['cleaning.contract.suspension_updated', 'unpaid_invoices'],
      ['cleaning.contract.suspension_updated', 'organization_suspended'],
      ['cleaning.contract.resumed', 'unpaid_invoices'],
    ]);
    const trail = await pool.query(
      "SELECT action FROM audit_log WHERE entity_id = $1 AND action LIKE 'mission.%' ORDER BY at, id",
      [missionId],
    );
    expect(trail.rows.map((row) => row.action)).toEqual([
      'mission.suspended',
      'mission.suspension_cause_added',
      'mission.suspension_cause_lifted',
      'mission.resumed',
    ]);
  });

  it('organisation seule : suspension, réactivation, reprise avec reprogrammation (ADR-030)', async () => {
    const organizationId = '0192f1c4-0000-7000-8000-0000000000d0';
    const missionId = '0192f1c4-0000-7000-8000-0000000000d1';
    await prisma.mission.create({
      data: {
        id: missionId,
        requestId: '0192f1c4-0000-7000-8000-0000000000d2',
        quoteId: '0192f1c4-0000-7000-8000-0000000000d3',
        acceptanceKey: 'd',
        customerId: CUSTOMER_ID,
        organizationId,
        status: 'scheduled',
        serviceCode: 'home_cleaning',
        commune: 'Cotonou',
        address: 'Akpakpa',
        chosenSlotStart: new Date('2026-11-12T08:00:00Z'),
        chosenSlotEnd: new Date('2026-11-12T10:00:00Z'),
        recurrence: { period: 'week', visitsPerPeriod: 1, durationMonths: 3 },
        plannedInterventions: 13,
        paymentPlan: { option: 'full', timing: 'after', method: 'cash' },
        paymentTotal: 130000,
        depositPercent: 100,
        depositAmount: 130000,
        createdAt: new Date('2026-10-01T08:00:00Z'),
        updatedAt: new Date('2026-10-01T08:00:00Z'),
        interventions: {
          create: {
            id: '0192f1c4-0000-7000-8000-0000000000d4',
            status: 'planned',
            scheduledStart: new Date('2026-11-26T08:00:00Z'),
            scheduledEnd: new Date('2026-11-26T10:00:00Z'),
            durationMinutes: 120,
            agentIds: [AGENT_ID],
          },
        },
      },
    });
    const decision = (eventId: string, suspended: boolean, occurredAt: string) =>
      useCases.handleOrganizationEvent.execute({
        eventId,
        eventType: suspended ? 'identity.organization.suspended' : 'identity.organization.reactivated',
        organizationId,
        suspended,
        occurredAt,
      });
    expect(await decision('0192f1c4-0000-7000-8000-0000000000c1', true, '2026-10-24T07:00:00Z')).toEqual({
      examined: 1,
      changed: 1,
    });
    // Deux décisions de même date : la suspension l'emporte, quel que soit l'ordre d'arrivée.
    expect(await decision('0192f1c4-0000-7000-8000-0000000000c2', false, '2026-10-24T07:00:00Z')).toEqual({
      examined: 1,
      changed: 0,
    });
    expect(await deps.organizations.isSuspended(organizationId)).toBe(true);
    const suspended = (await deps.missions.findById(missionId))!;
    expect(suspended.suspension?.causes).toEqual(['organization_suspended']);
    expect(suspended.interventions[0]).toMatchObject({
      status: 'cancelled',
      cancellationCause: 'suspension',
    });

    expect(await decision('0192f1c4-0000-7000-8000-0000000000c3', false, '2026-10-24T09:00:00Z')).toEqual({
      examined: 1,
      changed: 1,
    });
    const resumed = (await deps.missions.findById(missionId))!;
    expect(resumed.suspension).toBeNull();
    const planned = resumed.interventions.filter((i) => i.status === 'planned');
    expect(planned).toHaveLength(1);
    expect(planned[0]!.scheduledStart.toISOString()).toBe('2026-11-26T08:00:00.000Z');
    const rows = (
      await pool.query(
        "SELECT event_type, payload->'payload' AS body FROM outbox WHERE payload->'payload'->>'missionId' = $1 " +
          'ORDER BY created_at, id',
        [missionId],
      )
    ).rows as { event_type: string; body: Record<string, unknown> }[];
    expect(rows.map((row) => row.event_type)).toEqual([
      'cleaning.contract.suspended',
      'cleaning.contract.resumed',
      'cleaning.mission.scheduled',
    ]);
    expect(rows[0]!.body).toMatchObject({
      cause: 'organization_suspended',
      unpaidCount: 0,
      cancelledInterventionIds: ['0192f1c4-0000-7000-8000-0000000000d4'],
      releasedAgentIds: [AGENT_ID],
    });
    expect(rows[1]!.body).toMatchObject({
      cause: 'organization_suspended',
      unpaidCount: 0,
      rescheduledCount: 1,
      failedCount: 0,
    });
  });

  it('acceptation d’un devis : refusée sous le verrou pour une organisation suspendue (ADR-030)', async () => {
    const suspendedOrganization = '0192f1c4-0000-7000-8000-0000000000e0';
    const activeOrganization = '0192f1c4-0000-7000-8000-0000000000e1';
    await deps.organizations.record({
      eventId: '0192f1c4-0000-7000-8000-0000000000e2',
      consumer: 'cleaning.identity.organization.suspended',
      organizationId: suspendedOrganization,
      suspended: true,
      at: new Date('2026-10-23T07:00:00Z'),
    });
    // Même événement livré deux fois : doublon reconnu.
    expect(
      await deps.organizations.record({
        eventId: '0192f1c4-0000-7000-8000-0000000000e2',
        consumer: 'cleaning.identity.organization.suspended',
        organizationId: suspendedOrganization,
        suspended: true,
        at: new Date('2026-10-23T07:00:00Z'),
      }),
    ).toBe('duplicate');
    const requestId = (await pool.query('SELECT id FROM quote_requests ORDER BY id LIMIT 1')).rows[0]
      .id as string;
    const request = (await deps.requests.findById(requestId))!;
    const template = (await deps.missions.list({}, { limit: 1, cursor: null })).items[0]!;
    const missionsBefore = (await pool.query('SELECT count(*)::int AS n FROM missions')).rows[0].n as number;
    const outboxBefore = await outbox();
    // Version périmée : si le verrou laisse passer, la mise à jour conditionnelle échoue (conflit).
    const attempt = (organizationId: string) =>
      deps.requests.accept(
        { ...request, organizationId, version: -1 },
        { ...template, id: '0192f1c4-0000-7000-8000-0000000000e3', organizationId, interventions: [] },
        'acc-org',
        { events: [], audit: [] },
      );
    expect(await attempt(suspendedOrganization)).toEqual({ status: 'organization_suspended' });
    expect(await attempt(activeOrganization)).toEqual({ status: 'conflict' });
    expect((await pool.query('SELECT count(*)::int AS n FROM missions')).rows[0].n).toBe(missionsBefore);
    expect(await outbox()).toEqual(outboxBefore);
    // Missions d'une organisation : seules les non terminées, de cette organisation.
    expect(await deps.missions.listActiveForOrganization(suspendedOrganization)).toEqual([]);
  });

  it('parcours par lieu : groupe idempotent en une transaction, ordre, filtres, types de lieu, zones (ADR-034)', async () => {
    const customer = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e77';
    const input: RequestQuoteGroupInput = {
      idempotencyKey: 'int-group-1',
      placeType: 'house',
      location: { latitude: 6.4489, longitude: 2.3556, accuracyMeters: 20 },
      landmark: 'Portail bleu',
      items: [
        {
          serviceCode: 'window_cleaning',
          answers: { window_count: 12, access: 'at_height' },
          optionSelections: [],
          frequency: 'once',
        },
        {
          serviceCode: 'house_cleaning',
          answers: {
            surface: 180,
            bedrooms: 4,
            bathrooms: 2,
            front_yard: true,
            back_yard: false,
            condition: 'normal',
          },
          optionSelections: [{ code: 'windows', answers: { window_count: 6 } }],
          frequency: 'monthly',
        },
      ],
      preferredSlots: [SLOT],
      comment: '',
    };
    const before = (await outbox()).length;
    // Deux appels simultanés avec la même clé : un seul groupe, deux demandes, deux événements.
    const [a, b] = await Promise.all([
      asCustomer(() => useCases.requestQuoteGroup.execute(input), customer),
      asCustomer(() => useCases.requestQuoteGroup.execute(input), customer),
    ]);
    expect(b.group.id).toBe(a.group.id);
    expect(a.requests.map((request) => request.serviceCode)).toEqual(['window_cleaning', 'house_cleaning']);
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM quote_requests WHERE group_id = $1', [a.group.id]))
        .rows[0].n,
    ).toBe(2);
    expect((await outbox()).length - before).toBe(2);
    const stored = await deps.requests.findGroup(a.group.id);
    expect(stored?.requests[1]).toMatchObject({
      placeType: 'house',
      location: { latitude: 6.4489, longitude: 2.3556, accuracyMeters: 20 },
      landmark: 'Portail bleu',
      geocodingProvider: 'nominatim',
      geocodedAddress: 'Zogbadjè, Abomey-Calavi, Atlantique, Bénin',
      commune: 'Abomey-Calavi',
      calculation: { priced: false, reason: 'price_not_set' },
    });
    expect((await deps.requests.groupSizes([a.group.id])).get(a.group.id)).toBe(2);
    const listed = await asSupervisor(() =>
      useCases.listQuoteRequests.execute({
        page: { limit: 10, cursor: null },
        status: '',
        groupId: a.group.id,
        placeType: 'house',
        serviceCode: 'house_cleaning',
      }),
    );
    expect(listed.items.map((request) => request.id)).toEqual([a.requests[1]!.id]);
    const { rows } = await pool.query(
      "SELECT payload FROM outbox WHERE payload->'payload'->>'groupId' = $1",
      [a.group.id],
    );
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain('Portail bleu');
    expect(JSON.stringify(rows)).not.toContain('6.4489');

    const saved = await asAdmin(() =>
      useCases.savePlaceType.execute({
        code: 'garage',
        label: 'Garage',
        description: '',
        icon: 'garage',
        displayOrder: 80,
        active: true,
        serviceCodes: ['window_cleaning'],
      }),
    );
    expect(saved.placeType).toMatchObject({ code: 'garage', serviceCodes: ['window_cleaning'] });
    expect((await deps.catalog.listPlaceTypes()).find((p) => p.code === 'garage')).toMatchObject({
      label: 'Garage',
      updatedBy: expect.any(String),
    });
    const zone = await asAdmin(() =>
      useCases.saveZone.execute({ commune: 'Sèmè-Podji', aliases: ['Sèmè-Kpodji'] }),
    );
    expect(zone.aliases).toEqual(['Sèmè-Kpodji']);
    expect((await deps.catalog.listZones()).find((z) => z.code === 'seme-podji')?.aliases).toEqual([
      'Sèmè-Kpodji',
    ]);
  });

  it('données de démonstration : chargées après les migrations, rejouables, désinsectisation sans prix', async () => {
    const demo = readFileSync(join(__dirname, '..', 'prisma', 'demo', 'demo-data.sql'), 'utf8');
    const client = await pool.connect();
    try {
      await client.query("SET ksp.demo = 'on'");
      await client.query(demo);
      await client.query(demo);
    } finally {
      client.release();
    }
    const services = await deps.catalog.listServices();
    const priced = Object.fromEntries(services.map((service) => [service.code, isFullyPriced(service)]));
    expect(priced).toEqual({
      garden_maintenance: true,
      home_cleaning: true,
      house_cleaning: false,
      office_cleaning: true,
      pest_control: false,
      post_construction: true,
      septic_emptying: true,
      window_cleaning: false,
      demo_sofa_cleaning: false,
    });
    // Parcours par lieu (ADR-034) : groupe de 3 demandes, commune choisie à la main, demande ancienne.
    const group = await deps.requests.findGroup('0192f1c4-de70-7000-8000-0000000a0001');
    expect(group?.requests.map((request) => [request.serviceCode, request.status])).toEqual([
      ['house_cleaning', 'received'],
      ['garden_maintenance', 'visit_scheduled'],
      ['septic_emptying', 'accepted'],
    ]);
    expect(group?.requests[0]).toMatchObject({
      geocodingProvider: 'nominatim',
      location: { latitude: 6.3654 },
    });
    const manual = await deps.requests.findById('0192f1c4-de70-7000-8000-0000000b0004');
    expect(manual).toMatchObject({ geocodingProvider: null, placeType: 'apartment' });
    expect(await deps.requests.findById('0192f1c4-de70-7000-8000-0000000b0005')).toMatchObject({
      location: null,
      groupId: null,
    });
    expect((await deps.missions.findById('0192f1c4-de70-7000-8000-0000000e0001'))?.location).toMatchObject({
      latitude: 6.3654,
      longitude: 2.4183,
    });
    for (const service of services) expect(definitionProblems(service)).toEqual([]);
    const versions = await pool.query(
      "SELECT count(*)::int AS n FROM pricing_rules WHERE created_by = 'demo' AND fields <> '[]'::jsonb",
    );
    expect(versions.rows[0].n).toBe(5);
  });
});
