import { type AppError, type RabbitMqConsumer, runWithContext } from '@ksp/platform';
import { type CleaningDeps, type ExecutionDeps } from '../src/application/deps';
import { AdminProgramUseCases } from '../src/application/execution/admin-programs.use-cases';
import { OrganizationEventsConsumer } from '../src/infrastructure/messaging/organization-events.consumer';
import { PrismaOrganizationUnitOfWork } from '../src/infrastructure/persistence/organizations/prisma-organization.repository';
import { PrismaSettingsRepository } from '../src/infrastructure/persistence/settings/prisma-settings.repository';
import { type PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { describeWithDatabase, HOOK_TIMEOUT_MS } from './support/database';
import { CUSTOMER, type LotCBench, openLotCBench } from './support/lot-c';
import { asStaffMember, harness, type LotEHarness, newId, seedProgram } from './support/lot-e';

/**
 * Critère du lot F (partie 18) contre un vrai PostgreSQL : situation des organisations. Les
 * événements de billing et d'identity sont injectés par l'écouteur (OrganizationEventsConsumer),
 * sur les dépôts Prisma ; RabbitMQ est remplacé par la liste des gestionnaires abonnés. Ignoré sans
 * TEST_DATABASE_URL.
 */
type Handler = (envelope: Record<string, unknown>) => Promise<void>;

describeWithDatabase('lot F : impayés et suspension des organisations (PostgreSQL)', () => {
  let bench: LotCBench;
  let prisma: PrismaService;
  let h: LotEHarness;
  let deps: CleaningDeps;
  const handlers = new Map<string, Handler>();

  beforeAll(async () => {
    bench = await openLotCBench('cleaning_lot_f');
    prisma = bench.db.prisma;
    h = harness(prisma, '2030-03-01T08:00:00Z');
    deps = {
      ...h.deps,
      moduleSettings: new PrismaSettingsRepository(prisma, h.deps.ids),
      organizations: new PrismaOrganizationUnitOfWork(prisma, h.clock, h.deps.ids),
    };
    const subscribe = async (type: string, handler: Handler) => void handlers.set(type, handler);
    await new OrganizationEventsConsumer(
      { subscribe } as unknown as RabbitMqConsumer,
      deps,
    ).onApplicationBootstrap();
  }, HOOK_TIMEOUT_MS);

  afterAll(() => bench?.db.close(), HOOK_TIMEOUT_MS);

  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: AppError) => error,
    );

  /** Événement de facture de billing (version 2 : facture mensuelle, sans `contractId`). */
  const invoiceEvent = (
    type: 'billing.invoice.overdue' | 'billing.invoice.paid',
    organizationId: string,
    invoiceId: string,
    eventId = newId(),
  ) => ({
    eventId,
    type,
    version: 2,
    occurredAt: h.clock.now().toISOString(),
    producer: 'billing',
    correlationId: newId(),
    payload: {
      invoiceId,
      invoiceNumber: 'FAC-2030-000001',
      customerId: newId(),
      organizationId,
      source: 'cleaning',
      total: { amount: 120_000, currency: 'XOF' },
      kind: 'monthly',
      overdueCount: 1,
      holderOverdueCount: 1,
      ...(type === 'billing.invoice.paid' ? { settledBy: 'payment' } : {}),
    },
  });
  const overdue = (organizationId: string, invoiceId: string, eventId?: string) =>
    handlers.get('billing.invoice.overdue')!(
      invoiceEvent('billing.invoice.overdue', organizationId, invoiceId, eventId),
    );
  const paid = (organizationId: string, invoiceId: string, eventId?: string) =>
    handlers.get('billing.invoice.paid')!(
      invoiceEvent('billing.invoice.paid', organizationId, invoiceId, eventId),
    );
  const decision = (
    type: 'identity.organization.suspended' | 'identity.organization.reactivated',
    organizationId: string,
    occurredAt: string,
  ) =>
    handlers.get(type)!({
      eventId: newId(),
      type,
      version: 1,
      occurredAt,
      producer: 'identity',
      correlationId: newId(),
      payload: {
        organizationId,
        legalName: 'Société Test',
        ...(type === 'identity.organization.suspended'
          ? { suspendedBy: newId(), reason: 'Contrôle en cours' }
          : { reactivatedBy: newId() }),
      },
    });

  /** Programme de 5 séances quotidiennes affectées, rattaché à l'organisation. */
  async function organizationProgram(organizationId: string, firstStart: string) {
    const seeded = await seedProgram(bench.db.pool, { count: 5, firstStart, payerKind: 'organization' });
    await bench.db.pool.query('UPDATE programs SET owner_id = $1 WHERE id = $2', [
      organizationId,
      seeded.programId,
    ]);
    return seeded;
  }

  const programRow = (programId: string) => prisma.program.findUniqueOrThrow({ where: { id: programId } });
  const outbox = async (eventType: string, organizationId: string) =>
    (await prisma.outboxEvent.findMany({ where: { eventType }, orderBy: { createdAt: 'asc' } }))
      .map((row) => row.payload as Record<string, unknown>)
      .filter((payload) => payload.organizationId === organizationId);
  const billingStanding = (organizationId: string) =>
    prisma.organizationBillingStanding.findUnique({ where: { organizationId } });

  it('critère : mois 1 payé, mois 2 impayé → avertissement, mois 3 impayé → suspension, paiement → reprise ; un programme suspendu par KSP le reste', async () => {
    const organizationId = newId();
    const [january, february, march] = [newId(), newId(), newId()];
    h.clock.set('2030-03-01T08:00:00Z');
    const first = await organizationProgram(organizationId, '2030-03-10T08:00:00Z');
    const second = await organizationProgram(organizationId, '2030-03-10T08:00:00Z');
    const byKsp = await organizationProgram(organizationId, '2030-03-10T08:00:00Z');
    const admin = new AdminProgramUseCases(deps as ExecutionDeps);
    const staff = newId();
    await asStaffMember(staff, () =>
      admin.suspendProgram({
        programId: byKsp.programId,
        idempotencyKey: `suspension-${byKsp.programId}`,
        reason: 'Contrôle qualité',
      }),
    );

    // Mois 1 : payé sans jamais avoir été impayé.
    await paid(organizationId, january);
    expect(await outbox('cleaning.organization.unpaid_warning', organizationId)).toHaveLength(0);

    // Mois 2 impayé : avertissement, aucun programme touché.
    await overdue(organizationId, february);
    expect(await outbox('cleaning.organization.unpaid_warning', organizationId)).toEqual([
      expect.objectContaining({
        unpaidCount: 1,
        warningThreshold: 1,
        suspensionThreshold: 2,
        overdueInvoiceIds: [february],
      }),
    ]);
    expect(await billingStanding(organizationId)).toMatchObject({
      overdueCount: 1,
      warningLevel: 1,
      version: 1,
    });
    expect((await programRow(first.programId)).status).toBe('confirmed');
    expect(
      await prisma.auditEntry.count({
        where: { action: 'organization.unpaid_warning', entityId: organizationId, actorId: 'system' },
      }),
    ).toBe(1);

    // Mois 3 impayé : tous les programmes suspendus, séances gelées, agents libérés.
    await overdue(organizationId, march);
    for (const seeded of [first, second]) {
      expect(await programRow(seeded.programId)).toMatchObject({
        status: 'suspended',
        suspensionCauses: ['unpaid_invoices'],
      });
      const sessions = await prisma.session.findMany({ where: { programId: seeded.programId } });
      expect(sessions.every((session) => session.status === 'suspended')).toBe(true);
      const assignments = await prisma.assignment.findMany({
        where: { sessionId: { in: seeded.sessionIds } },
      });
      expect(
        assignments.every((line) => line.status === 'removed' && line.removalReason === 'program_suspended'),
      ).toBe(true);
    }
    const suspended = await outbox('cleaning.program.suspended', organizationId);
    expect(suspended.filter((payload) => payload.unpaidCount === 2)).toEqual([
      expect.objectContaining({
        causes: ['unpaid_invoices'],
        threshold: 2,
        releasedAgentIds: [expect.any(String)],
      }),
      expect.objectContaining({ causes: ['unpaid_invoices'], threshold: 2 }),
    ]);
    // Programme déjà suspendu par KSP : la cause s'ajoute (RV-84), pas d'avertissement.
    expect((await programRow(byKsp.programId)).suspensionCauses).toEqual(['ksp_decision', 'unpaid_invoices']);
    expect(await outbox('cleaning.program.suspension_updated', organizationId)).toEqual([
      expect.objectContaining({
        programId: byKsp.programId,
        change: 'cause_added',
        cause: 'unpaid_invoices',
      }),
    ]);
    expect(await outbox('cleaning.organization.unpaid_warning', organizationId)).toHaveLength(1);

    // Paiement du mois 2, le 11 mars à midi : reprise, séances à réaffecter et rattrapages.
    h.clock.set('2030-03-11T12:00:00Z');
    await paid(organizationId, february);
    for (const seeded of [first, second]) {
      expect(await programRow(seeded.programId)).toMatchObject({
        status: 'confirmed',
        suspensionCauses: [],
        suspendedAt: null,
      });
      const sessions = await prisma.session.findMany({
        where: { programId: seeded.programId },
        orderBy: { rank: 'asc' },
      });
      // La séance du 14 mars est à plus de 48 h : « à affecter » ; les autres attendent un rattrapage.
      expect(sessions.map((session) => session.status)).toEqual([
        'suspended',
        'suspended',
        'suspended',
        'suspended',
        'to_assign',
      ]);
      expect(sessions.slice(0, 4).every((session) => session.catchUpSuggestedStart !== null)).toBe(true);
    }
    expect(await outbox('cleaning.program.resumed', organizationId)).toEqual([
      expect.objectContaining({ sessionsToAssign: 1, liftedCause: 'unpaid_invoices' }),
      expect.objectContaining({ sessionsToAssign: 1, liftedCause: 'unpaid_invoices' }),
    ]);
    expect(
      await prisma.programSuspensionCause.count({
        where: { programId: { in: [first.programId, second.programId] }, liftedAt: null },
      }),
    ).toBe(0);
    // Cumul des causes : le programme suspendu par KSP reste suspendu après le paiement.
    expect(await programRow(byKsp.programId)).toMatchObject({
      status: 'suspended',
      suspensionCauses: ['ksp_decision'],
    });
    expect(await billingStanding(organizationId)).toMatchObject({ overdueCount: 1, warningLevel: 1 });

    // Reprise par KSP, sous le verrou de l'organisation : le programme repart.
    await asStaffMember(staff, () =>
      admin.resumeProgram({ programId: byKsp.programId, idempotencyKey: `reprise-${byKsp.programId}` }),
    );
    expect((await programRow(byKsp.programId)).status).toBe('confirmed');
    expect(await outbox('cleaning.organization.unpaid_warning', organizationId)).toHaveLength(1);
  }, 120_000);

  it('critère : un événement rejoué ne change rien ; une facture soldée puis « impayée » en retard reste soldée', async () => {
    const organizationId = newId();
    const [january, february] = [newId(), newId()];
    h.clock.set('2030-04-01T08:00:00Z');
    const seeded = await organizationProgram(organizationId, '2030-04-10T08:00:00Z');
    const eventId = newId();
    await overdue(organizationId, february, eventId);
    const snapshot = async () => ({
      outbox: await prisma.outboxEvent.count(),
      audit: await prisma.auditEntry.count(),
      standing: await billingStanding(organizationId),
      invoices: await prisma.organizationInvoice.findMany({
        where: { organizationId },
        orderBy: { invoiceId: 'asc' },
      }),
      program: await programRow(seeded.programId),
    });
    const before = await snapshot();
    await overdue(organizationId, february, eventId);
    expect(await snapshot()).toEqual(before);
    expect(await prisma.processedEvent.count({ where: { eventId } })).toBe(1);

    // Facture soldée, puis son « impayée » arrive en retard : elle reste soldée.
    await paid(organizationId, january);
    await overdue(organizationId, january);
    expect(
      await prisma.organizationInvoice.findUniqueOrThrow({ where: { invoiceId: january } }),
    ).toMatchObject({
      standing: 'paid',
    });
    expect(await billingStanding(organizationId)).toMatchObject({ overdueCount: 1 });
    expect((await programRow(seeded.programId)).status).toBe('confirmed');
  }, 120_000);

  it('deux événements simultanés de la même organisation passent l’un après l’autre', async () => {
    const organizationId = newId();
    h.clock.set('2030-04-01T08:00:00Z');
    const seeded = await organizationProgram(organizationId, '2030-04-10T08:00:00Z');
    await Promise.all([overdue(organizationId, newId()), overdue(organizationId, newId())]);
    expect(await billingStanding(organizationId)).toMatchObject({ overdueCount: 2, version: 2 });
    expect(await outbox('cleaning.organization.unpaid_warning', organizationId)).toHaveLength(1);
    expect(await outbox('cleaning.program.suspended', organizationId)).toHaveLength(1);
    expect((await programRow(seeded.programId)).status).toBe('suspended');
  }, 120_000);

  it('critère : organisation suspendue par KSP puis réactivée ; un événement plus ancien est ignoré', async () => {
    const organizationId = newId();
    h.clock.set('2030-05-01T08:00:00Z');
    const seeded = await organizationProgram(organizationId, '2030-05-10T08:00:00Z');

    await decision('identity.organization.suspended', organizationId, '2030-05-01T07:00:00.000Z');
    expect(await prisma.organizationStanding.findUniqueOrThrow({ where: { organizationId } })).toMatchObject({
      suspended: true,
      changedAt: new Date('2030-05-01T07:00:00.000Z'),
    });
    expect(await programRow(seeded.programId)).toMatchObject({
      status: 'suspended',
      suspensionCauses: ['organization_suspended'],
    });
    expect(await outbox('cleaning.program.suspended', organizationId)).toEqual([
      expect.objectContaining({ causes: ['organization_suspended'], unpaidCount: null, threshold: null }),
    ]);
    // Le motif de KSP (texte libre) n'est ni gardé ni publié.
    expect(
      await prisma.programSuspensionCause.findFirstOrThrow({ where: { programId: seeded.programId } }),
    ).toMatchObject({ cause: 'organization_suspended', reason: null, decidedBy: null, liftedAt: null });

    // Réactivation plus ancienne que la suspension appliquée : ignorée.
    await decision('identity.organization.reactivated', organizationId, '2030-04-30T07:00:00.000Z');
    expect((await programRow(seeded.programId)).status).toBe('suspended');
    expect(await prisma.organizationStanding.findUniqueOrThrow({ where: { organizationId } })).toMatchObject({
      suspended: true,
    });
    // À date égale, la suspension l'emporte.
    await decision('identity.organization.reactivated', organizationId, '2030-05-01T07:00:00.000Z');
    expect((await programRow(seeded.programId)).status).toBe('suspended');

    await decision('identity.organization.reactivated', organizationId, '2030-05-02T07:00:00.000Z');
    expect(await prisma.organizationStanding.findUniqueOrThrow({ where: { organizationId } })).toMatchObject({
      suspended: false,
    });
    expect(await programRow(seeded.programId)).toMatchObject({ status: 'confirmed', suspensionCauses: [] });
    expect(await outbox('cleaning.program.resumed', organizationId)).toEqual([
      expect.objectContaining({ liftedCause: 'organization_suspended', sessionsToAssign: 5 }),
    ]);
  }, 120_000);

  it('critère : acceptation d’un devis refusée au seuil de suspension', async () => {
    const organizationId = newId();
    const { requestId, quoteId } = await bench.toQuoteSent('lot-f-seuil');
    // Le dossier, monté au nom d'un particulier par le banc du lot C, passe à l'organisation.
    await bench.db.pool.query(
      `UPDATE places SET owner_kind = 'organization', owner_id = $1
       WHERE id = (SELECT place_id FROM cleaning_requests WHERE id = $2)`,
      [organizationId, requestId],
    );
    await bench.db.pool.query(
      "UPDATE cleaning_requests SET owner_kind = 'organization', owner_id = $1 WHERE id = $2",
      [organizationId, requestId],
    );
    h.clock.set('2030-06-01T08:00:00Z');
    await overdue(organizationId, newId());
    await overdue(organizationId, newId());

    const asOrganizationAdmin = <T>(fn: () => Promise<T>) =>
      runWithContext(
        {
          correlationId: 'test',
          callerService: 'gateway',
          user: {
            userId: CUSTOMER,
            sessionId: 's',
            activeContext: organizationId,
            roles: [{ role: 'org_admin', scopeType: 'org', scopeId: organizationId }],
            mfa: false,
          },
        },
        fn,
      );
    const refused = await failure(
      asOrganizationAdmin(() =>
        bench.useCases.quotes.accept({
          quoteId,
          idempotencyKey: 'cle-acceptation-seuil',
          acceptTerms: true,
          termsVersion: '',
        }),
      ),
    );
    expect(refused).toMatchObject({
      code: 'CLEANING_ORGANIZATION_UNPAID_INVOICES',
      details: { unpaidCount: 2, threshold: 2 },
    });
    expect(await prisma.program.count({ where: { ownerId: organizationId } })).toBe(0);
  }, 120_000);
});
