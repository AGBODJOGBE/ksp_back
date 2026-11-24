import { type AppError } from '@ksp/platform';
import { planNewProgram } from '../src/application/auto-planning/auto-planning.use-cases';
import { type ExecutionDeps } from '../src/application/deps';
import { AdminProgramUseCases } from '../src/application/execution/admin-programs.use-cases';
import { ExecutionTasks } from '../src/application/execution/execution-tasks';
import { ProgramAmendmentUseCases } from '../src/application/requests/program-amendment.use-cases';
import { ProgramRenewalUseCases } from '../src/application/requests/program-renewal.use-cases';
import { type SchedulePlanInput } from '../src/application/simulation/schedule';
import { PrismaExecutionRepository } from '../src/infrastructure/persistence/execution/prisma-execution.repository';
import { type PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { describeWithDatabase, HOOK_TIMEOUT_MS } from './support/database';
import {
  asCustomer,
  asStaff,
  CUSTOMER,
  type LotCBench,
  openLotCBench,
  VILLA,
  VISIT_FEE,
} from './support/lot-c';
import {
  asStaffMember,
  FakeDirectPayments,
  FakeInvoices,
  FakeWallet,
  newId,
  seedProgram,
} from './support/lot-e';

/**
 * Critère de la piste P (vie du programme) contre un vrai PostgreSQL : changement de plan, avenant
 * envoyé puis accepté, renouvellement proposé par la tâche puis accepté, nouvelle commande d'un
 * ponctuel terminé. La
 * planification automatique est remplacée par un témoin : seul son déclenchement est contrôlé ici.
 * Ignoré sans TEST_DATABASE_URL.
 */
jest.mock('../src/application/auto-planning/auto-planning.use-cases', () => ({
  ...jest.requireActual<object>('../src/application/auto-planning/auto-planning.use-cases'),
  planNewProgram: jest.fn(),
}));
jest.setTimeout(120_000);

const planning = jest.mocked(planNewProgram);
const SUPERVISOR = newId();
const DAY_MS = 86_400_000;

const plan = (patch: Partial<SchedulePlanInput>): SchedulePlanInput => ({
  kind: 'weekly',
  startTime: '14:00',
  dates: [],
  weekdays: ['thu'],
  monthDays: [],
  monthWeekdays: [],
  excludedDates: [],
  addedDates: [],
  excludeHolidays: false,
  ...patch,
});

describeWithDatabase('vie du programme (PostgreSQL)', () => {
  let bench: LotCBench;
  let prisma: PrismaService;
  let deps: ExecutionDeps;

  beforeAll(async () => {
    bench = await openLotCBench('cleaning_vie_programme');
    prisma = bench.db.prisma;
    const wallet = new FakeWallet();
    // Les cas d'usage du banc partagent ces dépendances : le lot E s'y ajoute.
    deps = Object.assign(bench.deps, {
      execution: new PrismaExecutionRepository(prisma, bench.deps.clock, bench.deps.ids),
      walletBalances: wallet,
      invoices: new FakeInvoices(),
      sessionPayments: new FakeDirectPayments(),
      placePoints: { points: async () => new Map() },
    }) as unknown as ExecutionDeps;
  }, HOOK_TIMEOUT_MS);

  afterAll(() => bench?.db.close(), HOOK_TIMEOUT_MS);

  beforeEach(() => planning.mockReset());

  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: AppError) => error,
    );
  const events = (type: string) => prisma.outboxEvent.count({ where: { eventType: type } });
  const program = (id: string) => prisma.program.findUniqueOrThrow({ where: { id } });
  const sessionsOf = (programId: string) =>
    prisma.session.findMany({ where: { programId }, orderBy: { rank: 'asc' } });
  const accept = (quoteId: string, key: string) =>
    asCustomer(() =>
      bench.useCases.quotes.accept({ quoteId, idempotencyKey: key, acceptTerms: true, termsVersion: '' }),
    );

  it('changement de plan : les 5 séances restantes sont déplacées, un plan de 4 séances passe par un avenant', async () => {
    // Programme hebdomadaire du mardi 9 h (Porto-Novo), 8 séances dont 3 réalisées.
    bench.setNow('2026-11-22T09:00:00Z');
    const seeded = await seedProgram(bench.db.pool, {
      count: 8,
      firstStart: '2026-11-03T08:00:00Z',
      status: 'in_progress',
    });
    for (const [index, id] of seeded.sessionIds.entries()) {
      const start = new Date(Date.parse('2026-11-03T08:00:00Z') + index * 7 * DAY_MS);
      const end = new Date(start.getTime() + 2 * 3_600_000);
      await prisma.session.update({
        where: { id },
        data: {
          scheduledStart: start,
          scheduledEnd: end,
          ...(index < 3
            ? {
                status: 'completed',
                startedAt: start,
                completedAt: end,
                beforePhotoFileIds: [newId()],
                afterPhotoFileIds: [newId()],
              }
            : {}),
        },
      });
    }
    const done = seeded.sessionIds.slice(0, 3);
    const remaining = seeded.sessionIds.slice(3);
    const before = await sessionsOf(seeded.programId);
    const admin = new AdminProgramUseCases(deps);
    const change = (key: string, weeks: number) =>
      asStaffMember(SUPERVISOR, () =>
        admin.changeProgramSchedule({
          programId: seeded.programId,
          idempotencyKey: key,
          effectiveFrom: '2026-11-24',
          schedule: plan({ startDate: '2026-11-26', durationWeeks: weeks }),
          reason: 'À la demande du client',
        }),
      );

    // 4 jeudis pour 5 séances : le prix changerait.
    expect(await failure(change('cle-plan-0001', 4))).toMatchObject({
      code: 'CLEANING_AMENDMENT_REQUIRED',
      details: { sessions: 5, planned: 4 },
    });
    expect(await prisma.sessionReschedule.count({ where: { sessionId: { in: remaining } } })).toBe(0);

    const moved = await events('cleaning.session.rescheduled');
    const changed = await change('cle-plan-0002', 5);
    expect(changed).toMatchObject({ id: seeded.programId, sessionsCount: 8, planKind: 'weekly' });
    const after = await sessionsOf(seeded.programId);
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(after.map((row) => row.price)).toEqual(before.map((row) => row.price));
    expect(after.slice(0, 3).map((row) => [row.status, row.scheduledStart])).toEqual(
      before.slice(0, 3).map((row) => ['completed', row.scheduledStart]),
    );
    // Jeudi 14 h à Porto-Novo = 13 h UTC, 2 h par séance comme avant.
    expect(after.slice(3).map((row) => row.scheduledStart.toISOString())).toEqual([
      '2026-11-26T13:00:00.000Z',
      '2026-12-03T13:00:00.000Z',
      '2026-12-10T13:00:00.000Z',
      '2026-12-17T13:00:00.000Z',
      '2026-12-24T13:00:00.000Z',
    ]);
    for (const row of after.slice(3)) {
      expect(row).toMatchObject({ status: 'to_assign', paymentStatus: 'not_due', price: 10_000 });
      expect(row.scheduledEnd.getTime() - row.scheduledStart.getTime()).toBe(2 * 3_600_000);
    }
    const confirmed = (sessionIds: string[]) =>
      prisma.assignment.count({ where: { sessionId: { in: sessionIds }, status: 'confirmed' } });
    expect(await confirmed(remaining)).toBe(0);
    expect(await confirmed(done)).toBe(3);
    expect(
      await prisma.assignment.count({ where: { sessionId: { in: remaining }, status: 'removed' } }),
    ).toBe(5);
    expect(await prisma.sessionReschedule.count({ where: { sessionId: { in: remaining } } })).toBe(5);
    expect((await events('cleaning.session.rescheduled')) - moved).toBe(5);
    expect(
      await prisma.auditEntry.count({
        where: { action: 'program.schedule_changed', entityId: seeded.programId },
      }),
    ).toBe(1);
    expect(planning).toHaveBeenCalledTimes(1);
    expect(planning.mock.calls[0]?.[1]).toBe(seeded.programId);

    // Rejeu de la même clé : même réponse, rien de plus.
    const replayed = await change('cle-plan-0002', 5);
    expect(replayed.id).toBe(seeded.programId);
    expect(await prisma.sessionReschedule.count({ where: { sessionId: { in: remaining } } })).toBe(5);
    expect((await events('cleaning.session.rescheduled')) - moved).toBe(5);
    expect(
      (await sessionsOf(seeded.programId)).map((row) => [row.id, row.scheduledStart, row.version]),
    ).toEqual(after.map((row) => [row.id, row.scheduledStart, row.version]));
  });

  it('avenant d’un type et de 2 séances : envoyé, accepté, le programme est complété sans en créer un autre', async () => {
    // Demande d'un seul type (sol), portée jusqu'au programme : lundis 30 novembre et 7 décembre.
    const sol = bench.catalog.solTypeId;
    // Le nombre de fenêtres n'est demandé que pour les vitres : il viendra avec l'avenant.
    const { fenetres, ...declared } = VILLA;
    const retained = { ...declared, superficie: 150 };
    bench.setNow('2026-11-20T09:00:00Z');
    bench.wallet.balance += VISIT_FEE;
    const requestId = (await bench.submit('avenant', { cleaningTypeIds: [sol], values: declared })).request
      .id;
    bench.setNow('2026-11-20T15:00:00Z');
    const scheduled = await asStaff(() =>
      bench.useCases.visitsAdmin.schedule({
        requestId,
        idempotencyKey: 'cle-visite-avenant',
        scheduledAt: '2026-11-21T09:00:00Z',
        agentIds: [],
        overrides: [],
      }),
    );
    bench.setNow('2026-11-21T10:00:00Z');
    await asStaff(() =>
      bench.useCases.visitsAdmin.completeOnBehalf({
        visitId: scheduled.visits[0]!.id,
        idempotencyKey: 'cle-cloture-avenant',
        reason: 'Constat dicté par téléphone',
        completedAt: '2026-11-21T09:45:00Z',
        values: retained,
        photoFileIds: [],
      }),
    );
    bench.setNow('2026-11-21T11:00:00Z');
    await asStaff(() =>
      bench.useCases.retained.save({ requestId, values: retained, cleaningTypeIds: [sol] }),
    );
    const initial = await asStaff(() =>
      bench.useCases.quotesAdmin.create({ requestId, idempotencyKey: 'cle-devis-avenant' }),
    );
    await asStaff(() =>
      bench.useCases.quotesAdmin.send({ quoteId: initial.quote.id, idempotencyKey: 'cle-envoi-avenant' }),
    );
    bench.setNow('2026-11-21T22:00:00Z');
    const first = await accept(initial.quote.id, 'cle-acc-avenant-01');
    const programId = first.program.id;
    const price = first.program.sessionPrice;
    const [started, upcoming] = (await sessionsOf(programId)).map((row) => row.id) as [string, string];
    // La première séance a démarré : l'avenant ne la changera pas.
    bench.setNow('2026-11-30T07:30:00Z');
    await prisma.program.update({ where: { id: programId }, data: { status: 'in_progress' } });
    await prisma.session.update({
      where: { id: started },
      data: { status: 'in_progress', startedAt: new Date('2026-11-30T07:00:00Z') },
    });

    const amendments = new ProgramAmendmentUseCases(deps);
    const prepare = (key: string) =>
      asStaff(() =>
        amendments.create({
          programId,
          idempotencyKey: key,
          addCleaningTypeIds: [bench.catalog.vitresTypeId],
          addSchedule: plan({
            kind: 'one_off',
            weekdays: [],
            startTime: '08:00',
            dates: ['2026-12-14', '2026-12-21'],
          }),
          values: { fenetres },
        }),
      );
    const { quote: draft } = await prepare('cle-avenant-0001');
    expect(draft).toMatchObject({
      kind: 'amendment',
      status: 'draft',
      programId,
      sessionsCount: 3,
      visitFeeDeduction: 0,
      total: draft.sessionPrice * 3,
    });
    expect(draft.sessionPrice).toBeGreaterThan(price);
    expect(draft.lines.filter((line) => line.kind === 'offer').map((line) => line.cleaningTypeId)).toEqual(
      expect.arrayContaining([sol, bench.catalog.vitresTypeId]),
    );
    expect((await prepare('cle-avenant-0001')).quote.id).toBe(draft.id);
    expect(
      await prisma.auditEntry.count({ where: { action: 'program.amendment_created', entityId: programId } }),
    ).toBe(1);
    // Rien n'a changé tant que le devis n'est pas accepté.
    expect(await program(programId)).toMatchObject({ sessionPrice: price });
    expect(await prisma.requestItem.count({ where: { requestId } })).toBe(1);

    const sent = await asStaff(() =>
      bench.useCases.quotesAdmin.send({ quoteId: draft.id, idempotencyKey: 'cle-avenant-envoi' }),
    );
    expect(sent.quote).toMatchObject({ status: 'sent', sessionsCount: 3, total: draft.total });
    expect(await prisma.cleaningRequest.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({
      status: 'accepted',
    });
    const announced = await prisma.outboxEvent.findMany({ where: { eventType: 'cleaning.quote.sent' } });
    expect(
      announced
        .map((row) => (row.payload as { payload: Record<string, unknown> }).payload)
        .filter((content) => content.quoteId === draft.id),
    ).toEqual([expect.objectContaining({ kind: 'amendment', sessionsCount: 3 })]);

    bench.setNow('2026-12-01T10:00:00Z');
    planning.mockReset();
    const accepted = await accept(draft.id, 'cle-acc-avenant-02');
    expect(accepted.quote.status).toBe('accepted');
    expect(accepted.program.id).toBe(programId);
    // Aucun nouveau programme ; le programme reprend le prix du devis et le type ajouté.
    expect(await prisma.program.count({ where: { requestId } })).toBe(1);
    const amended = await program(programId);
    expect(amended).toMatchObject({ status: 'in_progress', sessionPrice: draft.sessionPrice });
    expect(amended.schedulePlan).toMatchObject({ addedDates: ['2026-12-14', '2026-12-21'] });
    expect(await prisma.requestItem.count({ where: { requestId } })).toBe(2);
    expect((await deps.execution.program(programId))!.cleaningTypes.map((type) => type.id).sort()).toEqual(
      [sol, bench.catalog.vitresTypeId].sort(),
    );
    // Séance démarrée : inchangée ; séance restante : nouveau prix ; 2 séances ajoutées à la suite.
    const rows = await sessionsOf(programId);
    expect(rows.map((row) => [row.rank, row.status, row.price])).toEqual([
      [1, 'in_progress', price],
      [2, 'to_assign', draft.sessionPrice],
      [3, 'to_assign', draft.sessionPrice],
      [4, 'to_assign', draft.sessionPrice],
    ]);
    expect(rows[1]!.id).toBe(upcoming);
    expect(rows.slice(2).map((row) => row.scheduledStart.toISOString())).toEqual([
      '2026-12-14T07:00:00.000Z',
      '2026-12-21T07:00:00.000Z',
    ]);
    expect(planning).toHaveBeenCalledTimes(1);
    expect(planning.mock.calls[0]?.[1]).toBe(programId);

    // Rejeu de l'acceptation : rien de plus.
    await accept(draft.id, 'cle-acc-avenant-02');
    expect(await prisma.session.count({ where: { programId } })).toBe(4);
    expect(await prisma.program.count({ where: { requestId } })).toBe(1);
  });

  it('renouvellement : la tâche propose à 14 jours de la fin, l’acceptation crée le programme lié', async () => {
    // Programme hebdomadaire du lundi : 30 novembre et 7 décembre.
    const { requestId, quoteId } = await bench.toQuoteSent('renouv');
    bench.setNow('2026-11-21T22:00:00Z');
    const first = await accept(quoteId, 'cle-acc-renouv-01');
    const origin = first.program.id;
    const tasks = new ExecutionTasks(deps);

    // 15 jours avant la dernière séance : trop tôt.
    bench.setNow('2026-11-22T06:00:00Z');
    await expect(tasks.proposeRenewals()).resolves.toEqual({ processed: 0, failed: 0 });
    expect(await program(origin)).toMatchObject({ renewalStatus: null });

    // 14 jours avant : devis de renouvellement envoyé, mêmes conditions, sans nouvelle visite.
    bench.setNow('2026-11-23T08:00:00Z');
    await expect(tasks.proposeRenewals()).resolves.toEqual({ processed: 1, failed: 0 });
    expect(await program(origin)).toMatchObject({
      renewalStatus: 'proposed',
      renewalProposedAt: new Date('2026-11-23T08:00:00Z'),
    });
    const proposals = await prisma.quote.findMany({ where: { requestId, kind: 'renewal' } });
    expect(proposals).toHaveLength(1);
    const proposal = proposals[0]!;
    expect(proposal).toMatchObject({
      status: 'sent',
      programId: origin,
      sessionsCount: 2,
      visitFeeDeduction: 0,
      teamSize: first.program.teamSize,
      durationMinutes: first.program.durationMinutes,
    });
    // Même rythme, recalé après la dernière séance : lundis 14 et 21 décembre, 8 h (Porto-Novo).
    expect(proposal.scheduledDates).toEqual(['2026-12-14T07:00:00.000Z', '2026-12-21T07:00:00.000Z']);
    const announced = await prisma.outboxEvent.findMany({ where: { eventType: 'cleaning.quote.sent' } });
    const contents = announced.map((row) => (row.payload as { payload: Record<string, unknown> }).payload);
    expect(contents.filter((content) => content.quoteId === proposal.id)).toEqual([
      expect.objectContaining({ kind: 'renewal', requestId, sessionsCount: 2 }),
    ]);
    expect(await prisma.cleaningRequest.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({
      status: 'accepted',
    });

    // Second passage : une seule proposition par programme.
    await expect(tasks.proposeRenewals()).resolves.toEqual({ processed: 0, failed: 0 });
    expect(await prisma.quote.count({ where: { requestId, kind: 'renewal' } })).toBe(1);

    // Acceptation : nouveau programme lié à l'ancien, qui garde la réponse et poursuit sa vie.
    bench.setNow('2026-11-24T10:00:00Z');
    planning.mockReset();
    const accepted = await accept(proposal.id, 'cle-acc-renouv-02');
    const renewed = await program(accepted.program.id);
    expect(renewed).toMatchObject({
      requestId,
      quoteId: proposal.id,
      renewalOfProgramId: origin,
      status: 'confirmed',
      visitFeeToDeduct: 0,
    });
    expect((await sessionsOf(renewed.id)).map((row) => [row.rank, row.status])).toEqual([
      [1, 'to_assign'],
      [2, 'to_assign'],
    ]);
    expect(await program(origin)).toMatchObject({
      status: 'confirmed',
      renewalStatus: 'accepted',
      renewalRespondedAt: new Date('2026-11-24T10:00:00Z'),
      renewalRespondedBy: CUSTOMER,
    });
    expect(await prisma.program.count({ where: { requestId } })).toBe(2);
    expect(planning).toHaveBeenCalledTimes(1);
    expect(planning.mock.calls[0]?.[1]).toBe(renewed.id);

    // Encore un passage, puis une demande du client : le programme est déjà renouvelé.
    await expect(tasks.proposeRenewals()).resolves.toEqual({ processed: 0, failed: 0 });
    expect(await prisma.program.count({ where: { requestId } })).toBe(2);
    const renewals = new ProgramRenewalUseCases(deps);
    expect(
      await failure(asCustomer(() => renewals.renew({ programId: origin, idempotencyKey: 'cle-renouv-03' }))),
    ).toMatchObject({ code: 'CLEANING_RENEWAL_NOT_ALLOWED', details: { reason: 'already_renewed' } });
    // Un programme récurrent ne se « commande pas à nouveau ».
    expect(
      await failure(
        asCustomer(() =>
          renewals.reorder({
            programId: origin,
            idempotencyKey: 'cle-renouv-04',
            schedule: plan({ kind: 'one_off', weekdays: [], dates: ['2026-12-20'], startTime: '09:00' }),
          }),
        ),
      ),
    ).toMatchObject({ code: 'CLEANING_RENEWAL_NOT_ALLOWED', details: { reason: 'not_one_off' } });
  });

  it('nouvelle commande d’un ponctuel terminé : nouvelle demande sans visite, devis « reorder »', async () => {
    const { requestId, quoteId } = await bench.toQuoteSent('ponctuel');
    bench.setNow('2026-11-21T22:00:00Z');
    const first = await accept(quoteId, 'cle-acc-ponctuel-01');
    // Le programme devient un ponctuel terminé (constat du 21 novembre : moins de 12 mois).
    await prisma.program.update({
      where: { id: first.program.id },
      data: {
        status: 'completed',
        completedAt: new Date('2026-12-08T09:00:00Z'),
        schedulePlan: { kind: 'one_off', startTime: '08:00', dates: ['2026-11-30', '2026-12-07'] },
      },
    });
    bench.setNow('2026-12-10T09:00:00Z');
    const renewals = new ProgramRenewalUseCases(deps);
    const reorder = (key: string) =>
      asCustomer(() =>
        renewals.reorder({
          programId: first.program.id,
          idempotencyKey: key,
          schedule: plan({ kind: 'one_off', weekdays: [], dates: ['2026-12-20'], startTime: '09:00' }),
        }),
      );
    // Un ponctuel ne se renouvelle pas.
    expect(
      await failure(
        asCustomer(() => renewals.renew({ programId: first.program.id, idempotencyKey: 'cle-recmd-00' })),
      ),
    ).toMatchObject({ code: 'CLEANING_RENEWAL_NOT_ALLOWED', details: { reason: 'not_recurring' } });

    const submitted = await events('cleaning.request.submitted');
    const created = await reorder('cle-recmd-0001');
    expect(created.request.id).not.toBe(requestId);
    expect(created).toMatchObject({
      request: {
        status: 'visit_done',
        placeId: first.program.placeId,
        owner: { kind: 'user', id: CUSTOMER },
      },
      fees: [],
      visits: [],
      quotes: [],
      programId: null,
    });
    expect(created.request.number).toMatch(/^DN-/);
    expect(created.request.declaredValues).toEqual({ ...VILLA, superficie: 150 });
    expect(created.request.schedulePlan).toMatchObject({ kind: 'one_off', dates: ['2026-12-20'] });
    // Valeurs retenues recopiées, datées du constat d'origine.
    expect(created.revisions).toHaveLength(1);
    expect(created.revisions[0]).toMatchObject({ revision: 1, values: { ...VILLA, superficie: 150 } });
    expect(created.revisions[0]!.createdAt.getTime()).toBeLessThan(Date.parse('2026-11-22T00:00:00Z'));
    expect((await events('cleaning.request.submitted')) - submitted).toBe(1);

    // Rejeu : la même demande, aucune autre.
    const replayed = await reorder('cle-recmd-0001');
    expect(replayed.request.id).toBe(created.request.id);
    expect(await prisma.cleaningRequest.count({ where: { placeId: first.program.placeId } })).toBe(2);

    // Le devis se compose aussitôt, sans visite ni frais : il porte « reorder ».
    const draft = await asStaff(() =>
      bench.useCases.quotesAdmin.create({ requestId: created.request.id, idempotencyKey: 'cle-recmd-devis' }),
    );
    expect(draft.quote).toMatchObject({
      kind: 'reorder',
      programId: null,
      sessionsCount: 1,
      visitFeeDeduction: 0,
    });
    expect(await prisma.quote.findUniqueOrThrow({ where: { id: draft.quote.id } })).toMatchObject({
      kind: 'reorder',
      programId: null,
    });
  });
});
