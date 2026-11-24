import { type AppError, runWithContext } from '@ksp/platform';
import { AdminProgramUseCases } from '../src/application/execution/admin-programs.use-cases';
import { WalletDebitStatusUseCase } from '../src/application/execution/agent-activity.use-cases';
import { CustomerProgramUseCases } from '../src/application/execution/customer-programs.use-cases';
import { ExecutionTasks } from '../src/application/execution/execution-tasks';
import { type PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { ExecutionSchedulerService } from '../src/infrastructure/scheduling/execution-scheduler.service';
import {
  describeWithDatabase,
  HOOK_TIMEOUT_MS,
  openTestDatabase,
  type TestDatabase,
} from './support/database';
import {
  asCustomer,
  asStaffMember,
  harness,
  type LotEHarness,
  loadDemo,
  newId,
  runSession,
  seedProgram,
} from './support/lot-e';

/**
 * Lot E contre un vrai PostgreSQL : retard et suspension, paiement direct et reprise (R-SU-03),
 * tâches planifiées (SES-01, rappel, factures), décisions du back-office et du client. Wallet,
 * billing et payment sont des faux en mémoire. Ignoré sans TEST_DATABASE_URL.
 */
const SUPERVISORS = [newId(), newId()];

describeWithDatabase('lot E : parcours du programme (PostgreSQL)', () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let h: LotEHarness;

  beforeAll(async () => {
    db = await openTestDatabase('cleaning_lot_e_flows');
    prisma = db.prisma;
    await loadDemo(db.pool);
  }, HOOK_TIMEOUT_MS);

  afterAll(() => db?.close(), HOOK_TIMEOUT_MS);

  beforeEach(() => {
    h = harness(prisma, '2030-05-01T07:00:00Z');
  });

  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: AppError) => error,
    );
  const events = (type: string) => prisma.outboxEvent.count({ where: { eventType: type } });
  const session = (id: string) => prisma.session.findUniqueOrThrow({ where: { id } });
  const program = (id: string) => prisma.program.findUniqueOrThrow({ where: { id } });

  it('retard : suspension du programme, paiement direct, puis reprise et rattrapage', async () => {
    const seeded = await seedProgram(db.pool, { count: 3, firstStart: '2030-05-02T08:00:00Z' });
    const [first, second, third] = seeded.sessionIds as [string, string, string];
    await runSession(h, seeded.agentUserId, first, new Date('2030-05-02T08:00:00Z'));
    expect(await session(first)).toMatchObject({ paymentStatus: 'due', amountDue: 10_000 });

    // 24 h après la clôture : en retard, programme suspendu, séances à venir gelées, agents libérés.
    h.clock.set('2030-05-03T10:30:00Z');
    const tasks = new ExecutionTasks(h.deps);
    await expect(tasks.markOverdue()).resolves.toEqual({ processed: 1, failed: 0 });
    expect(await session(first)).toMatchObject({ paymentStatus: 'overdue' });
    expect(await program(seeded.programId)).toMatchObject({
      status: 'suspended',
      suspensionCauses: ['overdue_sessions'],
    });
    expect(await session(second)).toMatchObject({ status: 'suspended' });
    expect(await prisma.assignment.count({ where: { sessionId: third, status: 'confirmed' } })).toBe(0);
    expect(await events('cleaning.session.overdue')).toBeGreaterThanOrEqual(1);
    expect(await events('cleaning.program.suspended')).toBeGreaterThanOrEqual(1);

    // Paiement : wallet insuffisant refusé, Mobile Money de ce qui manque, page unique.
    const customer = new CustomerProgramUseCases(h.deps);
    const pay = (method: string, key: string) =>
      asCustomer(seeded.ownerId, () =>
        customer.paySession({ sessionId: first, idempotencyKey: key, method }),
      );
    expect(await failure(pay('wallet', 'paiement-wallet-1'))).toMatchObject({
      code: 'CLEANING_INSUFFICIENT_BALANCE',
      details: { missing: 10_000 },
    });
    h.wallet.credit(seeded.ownerId, 4_000);
    const page = await pay('mobile_money', 'paiement-momo-01');
    expect(page).toMatchObject({ status: 'awaiting_payment', amount: 6_000 });
    expect(page.checkoutUrl).toBeTruthy();
    const again = await pay('mobile_money', 'paiement-momo-02');
    expect(again.checkoutUrl).toBe(page.checkoutUrl);
    expect(h.directPayments.requests).toHaveLength(1);
    // Rejeu de la même clé : même réponse, sans nouvel effet.
    await expect(pay('mobile_money', 'paiement-momo-01')).resolves.toEqual(page);

    // Le paiement crédite le wallet ; le crédit qui vise la séance la débite, le programme reprend.
    h.wallet.credit(seeded.ownerId, 6_000);
    await tasks.onWalletCredited({
      holder: { type: 'user', id: seeded.ownerId },
      forObject: { service: 'cleaning', objectType: 'cleaning_session', objectId: first },
      paymentId: page.paymentId,
      amount: 6_000,
    });
    expect(await session(first)).toMatchObject({ paymentStatus: 'paid' });
    expect(await session(first).then((row) => row.invoiceId)).toBeTruthy();
    const resumed = await program(seeded.programId);
    expect(resumed).toMatchObject({ status: 'in_progress', suspensionCauses: [] });
    // Séances passées ou à moins de 48 h : date de rattrapage proposée, 1 à 8 semaines plus tard.
    const caught = await session(second);
    expect(caught.status).toBe('suspended');
    expect(caught.catchUpSuggestedStart?.toISOString()).toBe('2030-05-10T08:00:00.000Z');
    expect(await events('cleaning.program.resumed')).toBeGreaterThanOrEqual(1);
    expect(await prisma.directPayment.findFirstOrThrow({ where: { sessionId: first } })).toMatchObject({
      status: 'succeeded',
    });

    // Rapprochement de wallet : le débit est cité par la séance.
    const debit = [...h.wallet.debits.values()].find((line) => line.objectId === first)!;
    await expect(
      runWithContext({ correlationId: 't', callerService: 'wallet' }, () =>
        new WalletDebitStatusUseCase(h.deps).execute({
          objectType: 'cleaning_session',
          objectId: first,
          transactionId: debit.transactionId,
        }),
      ),
    ).resolves.toEqual({ recorded: true, status: 'recorded' });
    expect(
      await failure(
        runWithContext({ correlationId: 't', callerService: 'billing' }, () =>
          new WalletDebitStatusUseCase(h.deps).execute({
            objectType: 'cleaning_session',
            objectId: first,
            transactionId: '',
          }),
        ),
      ),
    ).toMatchObject({ code: 'CLEANING_CALLER_FORBIDDEN' });

    // Rattrapage confirmé par le superviseur : report de la séance suspendue.
    const admin = new AdminProgramUseCases(h.deps);
    await asStaffMember(SUPERVISORS[0]!, () =>
      admin.rescheduleSession({
        sessionId: second,
        idempotencyKey: `rattrapage-${second}`,
        newStart: '2030-05-10T08:00:00Z',
        reason: 'Rattrapage après suspension',
      }),
    );
    expect(await session(second)).toMatchObject({ status: 'to_assign', catchUpSuggestedStart: null });
  }, 120_000);

  it('paiement reçu pour une séance déjà payée : le montant reste au wallet', async () => {
    const seeded = await seedProgram(db.pool, { count: 1, firstStart: '2030-06-02T08:00:00Z' });
    h.wallet.credit(seeded.ownerId, 10_000);
    await runSession(h, seeded.agentUserId, seeded.sessionIds[0]!, new Date('2030-06-02T08:00:00Z'));
    await new ExecutionTasks(h.deps).onWalletCredited({
      holder: { type: 'user', id: seeded.ownerId },
      forObject: { service: 'cleaning', objectType: 'cleaning_session', objectId: seeded.sessionIds[0]! },
      paymentId: null,
      amount: 2_000,
    });
    expect(await events('cleaning.direct_payment.left_in_wallet')).toBe(1);
    expect(h.wallet.debits.size).toBe(1);
  }, 60_000);

  it('SES-01 : alerte à 48 h, puis annulation sans agent à la fin prévue', async () => {
    const seeded = await seedProgram(db.pool, { count: 1, firstStart: '2030-07-03T08:00:00Z' });
    const id = seeded.sessionIds[0]!;
    await db.pool.query("UPDATE sessions SET status = 'to_assign' WHERE id = $1", [id]);
    await db.pool.query(
      "UPDATE assignments SET status = 'removed', removed_at = now(), removal_reason = 'test' WHERE session_id = $1",
      [id],
    );
    const tasks = new ExecutionTasks(h.deps);
    h.clock.set('2030-07-01T09:00:00Z');
    await tasks.watchStaffing();
    expect(await session(id)).toMatchObject({ staffingAlertLevel: 'unassigned_48h' });
    await tasks.watchStaffing();
    expect(await events('cleaning.session.staffing_alert')).toBe(1);
    h.clock.set('2030-07-03T10:00:00Z');
    await tasks.watchStaffing();
    expect(await session(id)).toMatchObject({
      status: 'cancelled',
      cancelCause: 'no_agent',
      paymentStatus: 'not_due',
    });
    expect(await program(seeded.programId)).toMatchObject({ status: 'completed' });
  }, 60_000);

  it('rappel de la veille avec solde insuffisant, une seule fois', async () => {
    const seeded = await seedProgram(db.pool, { count: 1, firstStart: '2030-08-02T08:00:00Z' });
    h.wallet.credit(seeded.ownerId, 3_000);
    const tasks = new ExecutionTasks(h.deps);
    h.clock.set('2030-07-31T22:00:00Z');
    await tasks.sendReminders();
    expect(await session(seeded.sessionIds[0]!)).toMatchObject({ remindedAt: null });
    h.clock.set('2030-08-01T09:00:00Z');
    await tasks.sendReminders();
    await tasks.sendReminders();
    const reminders = await prisma.outboxEvent.findMany({
      where: { eventType: 'cleaning.session.reminder' },
    });
    const mine = reminders.filter((row) => JSON.stringify(row.payload).includes(seeded.sessionIds[0]!));
    expect(mine).toHaveLength(1);
    expect(JSON.stringify(mine[0]!.payload)).toContain('"balanceSufficient":false');
  }, 60_000);

  it('facture non émise (billing indisponible) : rejouée par la tâche', async () => {
    const seeded = await seedProgram(db.pool, { count: 1, firstStart: '2030-09-02T08:00:00Z' });
    h.wallet.credit(seeded.ownerId, 10_000);
    h.invoices.failing = true;
    await runSession(h, seeded.agentUserId, seeded.sessionIds[0]!, new Date('2030-09-02T08:00:00Z'));
    expect(await session(seeded.sessionIds[0]!)).toMatchObject({ paymentStatus: 'paid', invoiceId: null });
    h.invoices.failing = false;
    await new ExecutionTasks(h.deps).issuePendingInvoices();
    expect((await session(seeded.sessionIds[0]!)).invoiceId).toBeTruthy();
  }, 60_000);

  it('wallet en panne : débit en cours, rejoué après 2 minutes avec la même clé', async () => {
    const seeded = await seedProgram(db.pool, { count: 1, firstStart: '2030-10-02T08:00:00Z' });
    h.wallet.credit(seeded.ownerId, 10_000);
    h.wallet.failing = true;
    await runSession(h, seeded.agentUserId, seeded.sessionIds[0]!, new Date('2030-10-02T08:00:00Z'));
    const operation = await prisma.walletOperation.findFirstOrThrow({
      where: { sessionId: seeded.sessionIds[0]! },
    });
    expect(operation).toMatchObject({
      status: 'pending',
      idempotencyKey: `cleaning_session:${seeded.sessionIds[0]}`,
    });
    h.wallet.failing = false;
    h.clock.current = new Date(h.clock.current.getTime() + 3 * 60_000);
    await new ExecutionTasks(h.deps).replayWalletOperations();
    expect(await session(seeded.sessionIds[0]!)).toMatchObject({ paymentStatus: 'paid' });
  }, 60_000);

  it('back-office : clôture pour l’équipe (payée), accès impossible non facturé', async () => {
    const seeded = await seedProgram(db.pool, { count: 2, firstStart: '2030-11-02T08:00:00Z' });
    const [first, second] = seeded.sessionIds as [string, string];
    h.wallet.credit(seeded.ownerId, 10_000);
    const admin = new AdminProgramUseCases(h.deps);
    h.clock.set('2030-11-02T12:00:00Z');
    await asStaffMember(SUPERVISORS[0]!, () =>
      admin.completeSession({
        sessionId: first,
        idempotencyKey: `cloture-ksp-${first}`,
        reason: 'Téléphone de l’équipe en panne',
        startedAt: '2030-11-02T08:00:00Z',
        completedAt: '2030-11-02T10:00:00Z',
        presentAgentIds: [seeded.agentId],
      }),
    );
    expect(await session(first)).toMatchObject({
      status: 'completed',
      paymentStatus: 'paid',
      closedByStaff: true,
    });
    h.clock.set('2030-11-03T09:00:00Z');
    await asStaffMember(SUPERVISORS[0]!, () =>
      admin.reportSessionMissed({
        sessionId: second,
        idempotencyKey: `absence-ksp-${second}`,
        reason: 'Portail fermé',
        cause: 'access_impossible',
        missedAt: '2030-11-03T08:40:00Z',
        presentAgentIds: [seeded.agentId],
      }),
    );
    expect(await session(second)).toMatchObject({ status: 'missed', amountDue: 0, paymentStatus: 'not_due' });
    expect(h.wallet.debits.size).toBe(1);
    expect(await program(seeded.programId)).toMatchObject({ status: 'completed' });
    expect(
      await prisma.auditEntry.count({ where: { action: 'session.closed_by_ksp', actorId: SUPERVISORS[0]! } }),
    ).toBe(2);
  }, 60_000);

  it('client : report, annulation, note ; KSP : suspension, reprise, arrêt validé par une autre personne', async () => {
    const seeded = await seedProgram(db.pool, { count: 4, firstStart: '2031-01-06T08:00:00Z' });
    const [first, second, third] = seeded.sessionIds as [string, string, string];
    const customer = new CustomerProgramUseCases(h.deps);
    const admin = new AdminProgramUseCases(h.deps);
    const asOwner = <T>(fn: () => Promise<T>) => asCustomer(seeded.ownerId, fn);
    h.clock.set('2031-01-01T08:00:00Z');
    await asOwner(() =>
      customer.reschedule({
        sessionId: second,
        idempotencyKey: 'report-client-1',
        newStart: '2031-01-20T08:00:00Z',
      }),
    );
    expect(await session(second)).toMatchObject({ status: 'assigned' });
    expect(await prisma.sessionReschedule.count({ where: { sessionId: second } })).toBe(1);
    await asOwner(() => customer.cancelSession({ sessionId: third, idempotencyKey: 'annulation-client-1' }));
    expect(await session(third)).toMatchObject({ status: 'cancelled', cancelCause: 'customer' });
    // Hors périmètre : introuvable.
    expect(await failure(asCustomer(newId(), () => customer.getSession(first)))).toMatchObject({
      code: 'CLEANING_SESSION_NOT_FOUND',
    });

    await asStaffMember(SUPERVISORS[0]!, () =>
      admin.suspendProgram({
        programId: seeded.programId,
        idempotencyKey: 'suspension-ksp-1',
        reason: 'Litige',
      }),
    );
    expect(await program(seeded.programId)).toMatchObject({
      status: 'suspended',
      suspensionCauses: ['ksp_decision'],
    });
    expect(
      await failure(
        asOwner(() =>
          customer.reschedule({
            sessionId: first,
            idempotencyKey: 'report-client-2',
            newStart: '2031-01-21T08:00:00Z',
          }),
        ),
      ),
    ).toMatchObject({ code: 'CLEANING_PROGRAM_SUSPENDED' });
    const resumption = await asStaffMember(SUPERVISORS[0]!, () =>
      admin.resumeProgram({ programId: seeded.programId, idempotencyKey: 'reprise-ksp-1' }),
    );
    expect(resumption.program.status).toBe('confirmed');
    expect(await session(first)).toMatchObject({ status: 'to_assign' });

    await asStaffMember(SUPERVISORS[0]!, () =>
      admin.cancelProgram({
        programId: seeded.programId,
        idempotencyKey: 'arret-ksp-1',
        reason: 'Fin de contrat',
      }),
    );
    expect(
      await failure(
        asStaffMember(SUPERVISORS[0]!, () =>
          admin.approveProgramCancellation({ programId: seeded.programId, idempotencyKey: 'arret-ksp-ok-1' }),
        ),
      ),
    ).toMatchObject({ code: 'CLEANING_SECOND_APPROVER_REQUIRED' });
    const cancelled = await asStaffMember(SUPERVISORS[1]!, () =>
      admin.approveProgramCancellation({ programId: seeded.programId, idempotencyKey: 'arret-ksp-ok-2' }),
    );
    expect(cancelled.status).toBe('cancelled');
    expect(await session(first)).toMatchObject({ status: 'cancelled', cancelCause: 'program_stopped' });
    expect(await events('cleaning.program.cancelled')).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('arrêt par le client et note d’une séance réalisée', async () => {
    const seeded = await seedProgram(db.pool, { count: 3, firstStart: '2031-03-03T08:00:00Z' });
    const [first, second, third] = seeded.sessionIds as [string, string, string];
    h.wallet.credit(seeded.ownerId, 10_000);
    await runSession(h, seeded.agentUserId, first, new Date('2031-03-03T08:00:00Z'));
    const customer = new CustomerProgramUseCases(h.deps);
    const asOwner = <T>(fn: () => Promise<T>) => asCustomer(seeded.ownerId, fn);
    await asOwner(() =>
      customer.rateSession({
        sessionId: first,
        idempotencyKey: 'note-client-1',
        stars: 5,
        comment: 'Parfait',
      }),
    );
    expect(
      await failure(
        asOwner(() => customer.rateSession({ sessionId: first, idempotencyKey: 'note-client-2', stars: 4 })),
      ),
    ).toMatchObject({ code: 'CLEANING_RATING_ALREADY_GIVEN' });
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: seeded.agentId } })).toMatchObject({
      ratingSum: 5,
      ratingCount: 1,
    });
    // La séance 2 commence dans moins de 24 h : elle est maintenue ; la 3 est annulée.
    h.clock.set('2031-03-03T12:00:00Z');
    await asOwner(() =>
      customer.stopProgram({ programId: seeded.programId, idempotencyKey: 'arret-client-1' }),
    );
    expect(await program(seeded.programId)).toMatchObject({ status: 'cancelled', cancelledBy: 'customer' });
    expect(await session(second)).toMatchObject({ status: 'assigned' });
    expect(await session(third)).toMatchObject({ status: 'cancelled' });
  }, 60_000);

  it('tâches planifiées : un seul passage à la fois entre deux répliques (verrou consultatif)', async () => {
    const a = new ExecutionSchedulerService(prisma, h.deps, 0);
    const b = new ExecutionSchedulerService(prisma, h.deps, 0);
    const slow = jest
      .spyOn(a, 'runAll')
      .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 500)));
    const results = await Promise.all([
      a.tick(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(b.tick()), 100)),
    ]);
    expect(results.sort()).toEqual([false, true]);
    slow.mockRestore();
  }, 60_000);
});
