import { runWithContext } from '@ksp/platform';
import { type Pool } from 'pg';
import { ClaimAdminUseCases, ClaimUseCases } from '../src/application/claims/claims.use-cases';
import { type CleaningDeps } from '../src/application/deps';
import { PrismaIdempotencyStore } from '../src/infrastructure/persistence/catalog/prisma-catalog-settings';
import { PrismaClaimRepository } from '../src/infrastructure/persistence/claims/prisma-claim.repository';
import { UuidV7Generator } from '../src/infrastructure/system/system';
import {
  describeWithDatabase,
  HOOK_TIMEOUT_MS,
  openTestDatabase,
  type TestDatabase,
} from './support/database';
import { asStaffWith, loadDemo, seedProgram, seedSession } from './support/lot-g-seed';

/**
 * Réclamations (UC-NT-17, UC-NT-40) contre un vrai PostgreSQL : dépôt dans la fenêtre, échanges,
 * décisions (crédit versé une seule fois, deuxième personne au-delà de 50 000 FCFA, repasse
 * gratuite). Ignoré sans TEST_DATABASE_URL.
 */
const MANAGER = ['cleaning.claim.manage', 'cleaning.amounts.read'];
const NOW = new Date('2030-02-01T10:00:00+01:00');
const PHOTO = '0192f1c4-0000-7000-8000-00000000c001';

describeWithDatabase('réclamations (PostgreSQL)', () => {
  let db: TestDatabase;
  let pool: Pool;
  let deps: CleaningDeps;
  const ids = new UuidV7Generator();
  const credits: { idempotencyKey: string; amount: number }[] = [];
  const customer = ids.next();
  const [supervisor, finance] = [ids.next(), ids.next()];
  let programId: string;

  beforeAll(async () => {
    db = await openTestDatabase('cleaning_lot_g_claims');
    pool = db.pool;
    await loadDemo(pool);
    const program = await seedProgram(pool, { ownerId: customer, sessions: [] });
    programId = program.programId;
    deps = {
      claims: new PrismaClaimRepository(db.prisma, ids),
      idempotency: new PrismaIdempotencyStore(db.prisma),
      clock: { now: () => NOW },
      ids,
      photos: { attach: async () => undefined },
      people: {
        userNames: async (list: string[]) => new Map(list.map((id) => [id, `Nom ${id.slice(-4)}`])),
        organizationNames: async () => new Map(),
      },
      wallet: {
        credit: async (input: { idempotencyKey: string; amount: number }) => {
          const created = !credits.some((c) => c.idempotencyKey === input.idempotencyKey);
          if (created) credits.push({ idempotencyKey: input.idempotencyKey, amount: input.amount });
          return { transactionId: ids.next(), created };
        },
      },
    } as unknown as CleaningDeps;
  }, HOOK_TIMEOUT_MS);

  afterAll(() => db?.close(), HOOK_TIMEOUT_MS);

  const asCustomer = <T>(fn: () => T, userId = customer): T =>
    runWithContext(
      {
        correlationId: 'test',
        callerService: 'gateway',
        user: { userId, sessionId: 's', activeContext: 'personal', roles: [], mfa: false },
      },
      fn,
    );

  /** Séance réalisée il y a `hoursAgo` heures. */
  async function completedSession(hoursAgo: number, rank: number): Promise<string> {
    const end = new Date(NOW.getTime() - hoursAgo * 3_600_000);
    return seedSession(pool, {
      programId,
      rank,
      start: new Date(end.getTime() - 2 * 3_600_000).toISOString(),
      end: end.toISOString(),
      status: 'completed',
    });
  }

  const open = (sessionId: string, key = `reclamation-${ids.next()}`) =>
    asCustomer(() =>
      new ClaimUseCases(deps).open({
        sessionId,
        idempotencyKey: key,
        category: 'incomplete_work',
        text: 'La cuisine n’a pas été faite',
        photoFileIds: [PHOTO],
      }),
    );
  const admin = (permissions = MANAGER, userId = supervisor) => ({
    run: <T>(fn: (useCases: ClaimAdminUseCases) => Promise<T>) =>
      asStaffWith(permissions, () => fn(new ClaimAdminUseCases(deps)), userId),
  });

  it('R-RC-01 : dépôt dans les 48 h, rejouable ; au-delà refusé ; séance d’un autre client introuvable', async () => {
    const sessionId = await completedSession(2, 1);
    const key = `reclamation-${ids.next()}`;
    const first = await open(sessionId, key);
    expect(first.claim).toMatchObject({ status: 'open', category: 'incomplete_work' });
    expect((await open(sessionId, key)).claim.id).toBe(first.claim.id);
    expect(await db.prisma.outboxEvent.count({ where: { eventType: 'cleaning.claim.opened' } })).toBe(1);

    const old = await completedSession(49, 2);
    await expect(open(old)).rejects.toMatchObject({ code: 'CLEANING_CLAIM_WINDOW_CLOSED' });
    await expect(
      asCustomer(
        () =>
          new ClaimUseCases(deps).open({
            sessionId,
            idempotencyKey: `reclamation-${ids.next()}`,
            category: 'damage',
            text: 'x',
            photoFileIds: [],
          }),
        ids.next(),
      ),
    ).rejects.toMatchObject({ code: 'CLEANING_SESSION_NOT_FOUND' });
  }, 60_000);

  it('R-RC-02 : prise en charge, échanges, première réponse datée ; file du back-office', async () => {
    const { claim } = await open(await completedSession(1, 3));
    const taken = await admin().run((u) =>
      u.update({
        claimId: claim.id,
        idempotencyKey: `prise-${ids.next()}`,
        status: 'in_progress',
        message: 'Nous regardons',
      }),
    );
    expect(taken.claim).toMatchObject({ status: 'in_progress', firstResponseAt: NOW });
    const answered = await asCustomer(() =>
      new ClaimUseCases(deps).addMessage({
        claimId: claim.id,
        idempotencyKey: `message-${ids.next()}`,
        text: 'Merci',
      }),
    );
    expect(answered.claim.messages.map((m) => m.fromStaff)).toEqual([true, false]);
    const mine = await asCustomer(() => new ClaimUseCases(deps).listMine({}));
    expect(mine.items.map((v) => v.claim.id)).toContain(claim.id);
    const queue = await admin().run((u) => u.list({ status: 'in_progress' }));
    expect(queue.items.map((v) => v.claim.id)).toEqual([claim.id]);
    await expect(admin([]).run((u) => u.list({}))).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
  }, 60_000);

  it('R-RC-03 : crédit jusqu’à 50 000 FCFA versé au wallet une seule fois, même rejoué', async () => {
    const { claim } = await open(await completedSession(1, 4));
    const key = `decision-${ids.next()}`;
    const decide = () =>
      admin().run((u) =>
        u.decide({
          claimId: claim.id,
          idempotencyKey: key,
          outcome: 'wallet_credit',
          creditAmount: 10_000,
          reason: 'Geste',
        }),
      );
    const decided = await decide();
    expect(decided.claim).toMatchObject({
      status: 'resolved',
      decision: 'wallet_credit',
      creditAmount: 10_000,
    });
    await decide();
    expect(credits.filter((c) => c.idempotencyKey === `cleaning_claim_credit:${claim.id}`)).toEqual([
      { idempotencyKey: `cleaning_claim_credit:${claim.id}`, amount: 10_000 },
    ]);
    const operation = await db.prisma.walletOperation.findFirstOrThrow({ where: { claimId: claim.id } });
    expect(operation).toMatchObject({ status: 'succeeded', purpose: 'claim_credit', kind: 'credit' });
    expect(await db.prisma.auditEntry.count({ where: { action: 'claim.decided', entityId: claim.id } })).toBe(
      1,
    );
  }, 60_000);

  it('R-RC-03 : au-delà de 50 000 FCFA, une deuxième personne valide ; l’auteur ne peut pas', async () => {
    const { claim } = await open(await completedSession(1, 5));
    const pending = await admin().run((u) =>
      u.decide({
        claimId: claim.id,
        idempotencyKey: `decision-${ids.next()}`,
        outcome: 'wallet_credit',
        creditAmount: 80_000,
        reason: 'Dégât',
      }),
    );
    expect(pending.claim.status).toBe('in_progress');
    expect(await db.prisma.walletOperation.count({ where: { claimId: claim.id } })).toBe(0);
    await expect(
      admin().run((u) => u.approveCredit({ claimId: claim.id, idempotencyKey: `validation-${ids.next()}` })),
    ).rejects.toMatchObject({ code: 'CLEANING_SECOND_APPROVER_REQUIRED' });
    const approved = await admin(MANAGER, finance).run((u) =>
      u.approveCredit({ claimId: claim.id, idempotencyKey: `validation-${ids.next()}` }),
    );
    expect(approved.claim).toMatchObject({ status: 'resolved', creditApprovedBy: finance });
    expect(
      credits.some((c) => c.idempotencyKey === `cleaning_claim_credit:${claim.id}` && c.amount === 80_000),
    ).toBe(true);
    expect(await db.prisma.outboxEvent.count({ where: { eventType: 'cleaning.claim.resolved' } })).toBe(2);
  }, 60_000);

  it('R-RC-03 : repasse gratuite, séance à 0 FCFA ajoutée au programme, à affecter', async () => {
    const { claim } = await open(await completedSession(1, 6));
    const decided = await admin().run((u) =>
      u.decide({
        claimId: claim.id,
        idempotencyKey: `decision-${ids.next()}`,
        outcome: 'free_redo',
        creditAmount: null,
        reason: 'Refaite',
      }),
    );
    expect(decided.claim).toMatchObject({ status: 'resolved', decision: 'free_redo' });
    const redo = await db.prisma.session.findUniqueOrThrow({ where: { id: decided.claim.redoSessionId! } });
    expect(redo).toMatchObject({
      programId,
      price: 0,
      status: 'to_assign',
      freeRedoOfClaimId: claim.id,
      rank: 7,
    });
    expect(redo.scheduledStart.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 48 * 3_600_000);
    await expect(
      admin().run((u) =>
        u.decide({
          claimId: claim.id,
          idempotencyKey: `decision-${ids.next()}`,
          outcome: 'rejected',
          creditAmount: null,
          reason: 'x',
        }),
      ),
    ).rejects.toMatchObject({ code: 'CLEANING_INVALID_TRANSITION' });
  }, 60_000);
});
