import { type AppError } from '@ksp/platform';
import { FieldSessionUseCases } from '../src/application/execution/field.use-cases';
import { SessionPayments } from '../src/application/execution/session-payments';
import { type PrismaService } from '../src/infrastructure/prisma/prisma.service';
import {
  describeWithDatabase,
  HOOK_TIMEOUT_MS,
  openTestDatabase,
  type TestDatabase,
} from './support/database';
import { asCustomer, harness, type LotEHarness, loadDemo, newId, seedProgram } from './support/lot-e';

/**
 * Critère du lot E (partie 18) contre un vrai PostgreSQL : « 15 séances donnent 15 débits et 15
 * factures ; une séance en retard bloque la suivante et le paiement la débloque ». Wallet et billing
 * sont des faux en mémoire. Ignoré sans TEST_DATABASE_URL.
 */
describeWithDatabase('lot E : exécution et paiement par séance (PostgreSQL)', () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let h: LotEHarness;

  beforeAll(async () => {
    db = await openTestDatabase('cleaning_lot_e');
    prisma = db.prisma;
    await loadDemo(db.pool);
  }, HOOK_TIMEOUT_MS);

  afterAll(() => db?.close(), HOOK_TIMEOUT_MS);

  beforeEach(() => {
    h = harness(prisma, '2030-03-01T07:00:00Z');
  });

  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: AppError) => error,
    );

  /** Déroulé complet d'une séance par son chef d'équipe, à l'heure prévue. */
  async function runSession(agentUserId: string, sessionId: string, start: Date): Promise<void> {
    const field = new FieldSessionUseCases(h.deps);
    const as = <T>(fn: () => Promise<T>) => asCustomer(agentUserId, fn);
    const key = (step: string) => `${step}-${sessionId}`;
    h.clock.current = new Date(start.getTime() - 10 * 60_000);
    await as(() => field.arrive({ sessionId, idempotencyKey: key('arrivee') }));
    await as(() =>
      field.addPhoto({ sessionId, idempotencyKey: key('avant'), fileId: newId(), kind: 'before' }),
    );
    h.clock.current = start;
    await as(() => field.start({ sessionId, idempotencyKey: key('demarrage') }));
    const view = await as(() => field.get(sessionId));
    await as(() =>
      field.updateChecklist({
        sessionId,
        idempotencyKey: key('liste'),
        items: view.checklist.map((point) => ({
          code: point.code,
          checked: true,
          cleaningTypeCode: point.cleaningTypeCode,
        })),
      }),
    );
    await as(() =>
      field.addPhoto({ sessionId, idempotencyKey: key('apres'), fileId: newId(), kind: 'after' }),
    );
    h.clock.current = new Date(start.getTime() + 2 * 3_600_000);
    await as(() => field.complete({ sessionId, idempotencyKey: key('cloture') }));
  }

  it('critère : 15 séances donnent 15 débits et 15 factures', async () => {
    const seeded = await seedProgram(db.pool, { count: 15, firstStart: '2030-03-02T08:00:00Z' });
    h.wallet.credit(seeded.ownerId, 150_000);
    for (const [index, sessionId] of seeded.sessionIds.entries()) {
      await runSession(
        seeded.agentUserId,
        sessionId,
        new Date(Date.parse('2030-03-02T08:00:00Z') + index * 86_400_000),
      );
    }
    expect(h.wallet.debits.size).toBe(15);
    expect(h.wallet.balances.get(seeded.ownerId)).toBe(0);
    expect(h.invoices.invoices.size).toBe(15);
    const sessions = await prisma.session.findMany({ where: { programId: seeded.programId } });
    expect(sessions.every((session) => session.paymentStatus === 'paid' && session.invoiceId)).toBe(true);
    expect(await prisma.program.findUniqueOrThrow({ where: { id: seeded.programId } })).toMatchObject({
      status: 'completed',
    });
    expect(await prisma.outboxEvent.count({ where: { eventType: 'cleaning.session.paid' } })).toBe(15);
    expect(await prisma.outboxEvent.count({ where: { eventType: 'cleaning.program.completed' } })).toBe(1);
  }, 120_000);

  it('critère : une séance en retard bloque la suivante et le paiement la débloque', async () => {
    const seeded = await seedProgram(db.pool, { count: 3, firstStart: '2030-04-02T08:00:00Z' });
    const [first, second] = seeded.sessionIds;
    await runSession(seeded.agentUserId, first!, new Date('2030-04-02T08:00:00Z'));
    expect(await prisma.session.findUniqueOrThrow({ where: { id: first } })).toMatchObject({
      paymentStatus: 'due',
    });
    expect(await prisma.outboxEvent.count({ where: { eventType: 'cleaning.session.payment_due' } })).toBe(1);
    // Le lendemain, 24 h après la clôture : la séance 1 est en retard, la séance 2 ne démarre pas.
    const field = new FieldSessionUseCases(h.deps);
    h.clock.set('2030-04-03T07:50:00Z');
    await asCustomer(seeded.agentUserId, () =>
      field.addPhoto({
        sessionId: second!,
        idempotencyKey: `avant-${second}`,
        fileId: newId(),
        kind: 'before',
      }),
    );
    h.clock.set('2030-04-03T10:30:00Z');
    expect(
      await failure(
        asCustomer(seeded.agentUserId, () =>
          field.start({ sessionId: second!, idempotencyKey: `demarrage-${second}` }),
        ),
      ),
    ).toMatchObject({ code: 'CLEANING_SESSION_OVERDUE_PAYMENT' });
    // Recharge : le débit en attente est relancé, la séance 2 démarre.
    h.wallet.credit(seeded.ownerId, 10_000);
    await expect(new SessionPayments(h.deps).relaunch({ kind: 'user', id: seeded.ownerId })).resolves.toBe(1);
    expect(await prisma.session.findUniqueOrThrow({ where: { id: first } })).toMatchObject({
      paymentStatus: 'paid',
    });
    await asCustomer(seeded.agentUserId, () =>
      field.start({ sessionId: second!, idempotencyKey: `demarrage-2-${second}` }),
    );
    expect(await prisma.session.findUniqueOrThrow({ where: { id: second } })).toMatchObject({
      status: 'in_progress',
    });
  }, 120_000);
});
