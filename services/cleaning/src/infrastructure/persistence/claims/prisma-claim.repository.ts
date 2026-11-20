import { type Prisma } from '../../../../prisma/generated';
import { ConcurrentUpdateError } from '../../../application/agents/agent.ports';
import {
  type ClaimFilter,
  type ClaimPatch,
  type ClaimRecord,
  type ClaimRepository,
  type ClaimSessionRecord,
  type NewClaim,
  type NewClaimCredit,
  type NewRedoSession,
  type PendingCredit,
} from '../../../application/claims/claims.ports';
import { type Changes, type IdGenerator } from '../../../application/ports';
import { type Page, type PageRequest } from '../../../application/shared/input';
import { type PrismaService } from '../../prisma/prisma.service';
import { isUuid } from '../agents/agent-rows';
import { type Tx, writeChanges } from '../changes';

/** Réclamations (lot G) : écritures conditionnées par la version, dans la transaction de leurs changements. */

const sessionInclude = {
  program: {
    select: {
      id: true,
      number: true,
      ownerKind: true,
      ownerId: true,
      communeKey: true,
      request: { select: { submittedBy: true } },
      _count: { select: { sessions: true } },
    },
  },
} satisfies Prisma.SessionInclude;

type SessionRow = Prisma.SessionGetPayload<{ include: typeof sessionInclude }>;

const claimInclude = {
  session: { include: sessionInclude },
  messages: { orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] },
  freeRedoSession: { select: { id: true } },
} satisfies Prisma.ClaimInclude;

type ClaimRow = Prisma.ClaimGetPayload<{ include: typeof claimInclude }>;

function toSession(row: SessionRow): ClaimSessionRecord {
  const program = row.program;
  return {
    id: row.id,
    programId: program.id,
    programNumber: program.number,
    rank: row.rank,
    sessionsCount: program._count.sessions,
    status: row.status,
    completedAt: row.completedAt,
    start: row.scheduledStart,
    end: row.scheduledEnd,
    ownerKind: program.ownerKind,
    ownerId: program.ownerId,
    customerId: program.ownerKind === 'user' ? program.ownerId : program.request.submittedBy,
    organizationId: program.ownerKind === 'organization' ? program.ownerId : null,
    communeKey: program.communeKey,
  };
}

function toClaim(row: ClaimRow): ClaimRecord {
  return {
    id: row.id,
    session: toSession(row.session),
    openedBy: row.openedBy,
    category: row.reason,
    text: row.text,
    photoFileIds: row.photoFileIds,
    status: row.status,
    decision: row.decision,
    decisionReason: row.decisionReason,
    creditAmount: row.creditAmount,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    creditApprovedBy: row.creditApprovedBy,
    firstResponseAt: row.firstResponseAt,
    redoSessionId: row.freeRedoSession?.id ?? null,
    openedAt: row.createdAt,
    closedAt: row.closedAt,
    version: row.version,
    messages: row.messages.map((m) => ({
      id: m.id,
      authorId: m.authorId,
      fromStaff: m.fromStaff,
      body: m.body,
      createdAt: m.createdAt,
    })),
  };
}

function where(filter: ClaimFilter): Prisma.ClaimWhereInput {
  const conditions: Prisma.ClaimWhereInput[] = [];
  if (filter.owner) {
    conditions.push({ session: { program: { ownerKind: filter.owner.kind, ownerId: filter.owner.id } } });
  }
  if (filter.status) conditions.push({ status: filter.status as ClaimRecord['status'] });
  if (filter.agentId) {
    if (!isUuid(filter.agentId)) return { id: { in: [] } };
    conditions.push({ session: { assignments: { some: { agentId: filter.agentId, status: 'confirmed' } } } });
  }
  if (filter.customerId) {
    if (!isUuid(filter.customerId)) return { id: { in: [] } };
    conditions.push({
      session: {
        program: {
          OR: [
            { ownerKind: 'user', ownerId: filter.customerId },
            { ownerKind: 'organization', request: { submittedBy: filter.customerId } },
          ],
        },
      },
    });
  }
  if (filter.organizationId) {
    if (!isUuid(filter.organizationId)) return { id: { in: [] } };
    conditions.push({ session: { program: { ownerKind: 'organization', ownerId: filter.organizationId } } });
  }
  return { AND: conditions };
}

export class PrismaClaimRepository implements ClaimRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ids: IdGenerator,
  ) {}

  async session(id: string): Promise<ClaimSessionRecord | null> {
    if (!isUuid(id)) return null;
    const row = await this.prisma.session.findUnique({ where: { id }, include: sessionInclude });
    return row ? toSession(row) : null;
  }

  async claim(id: string): Promise<ClaimRecord | null> {
    if (!isUuid(id)) return null;
    const row = await this.prisma.claim.findUnique({ where: { id }, include: claimInclude });
    return row ? toClaim(row) : null;
  }

  async list(filter: ClaimFilter, page: PageRequest): Promise<Page<ClaimRecord>> {
    const offset = page.cursor ? Number(page.cursor) : 0;
    const direction = filter.sort === 'openedAt' ? 'asc' : 'desc';
    const [total, rows] = await Promise.all([
      this.prisma.claim.count({ where: where(filter) }),
      this.prisma.claim.findMany({
        where: where(filter),
        include: claimInclude,
        orderBy: [{ createdAt: direction }, { id: direction }],
        skip: offset,
        take: page.limit,
      }),
    ]);
    return {
      items: rows.map(toClaim),
      nextCursor: offset + page.limit < total ? String(offset + page.limit) : null,
      total,
    };
  }

  async claimSettings(): Promise<{ windowHours: number; leadHours: number }> {
    const row = await this.prisma.cleaningSettings.findUniqueOrThrow({ where: { id: 1 } });
    return { windowHours: row.claimWindowHours, leadHours: row.firstSessionLeadHours };
  }

  async programSlots(programId: string): Promise<{ start: Date; end: Date }[]> {
    const rows = await this.prisma.session.findMany({
      where: { programId, status: { not: 'cancelled' } },
      select: { scheduledStart: true, scheduledEnd: true },
    });
    return rows.map((r) => ({ start: r.scheduledStart, end: r.scheduledEnd }));
  }

  async insert(claim: NewClaim, changes: Changes): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await writeChanges(tx, changes, () => this.ids.next());
      await tx.claim.create({
        data: {
          id: claim.id,
          sessionId: claim.sessionId,
          openedBy: claim.openedBy,
          reason: claim.category,
          text: claim.text,
          photoFileIds: [...claim.photoFileIds],
          createdAt: claim.at,
          updatedAt: claim.at,
        },
      });
    });
  }

  async update(
    id: string,
    expectedVersion: number,
    patch: ClaimPatch,
    effects: { redo: NewRedoSession | null; credit: NewClaimCredit | null; at: Date },
    changes: Changes,
  ): Promise<void> {
    const { message, ...fields } = patch;
    await this.prisma.$transaction(async (tx) => {
      await writeChanges(tx, changes, () => this.ids.next());
      const { count } = await tx.claim.updateMany({
        where: { id, version: expectedVersion },
        data: { ...fields, updatedAt: effects.at, version: { increment: 1 } },
      });
      if (count !== 1) throw new ConcurrentUpdateError();
      if (message) {
        await tx.claimMessage.create({ data: { ...message, claimId: id, createdAt: effects.at } });
      }
      if (effects.redo) await insertRedo(tx, id, effects.redo, effects.at);
      if (effects.credit) await insertCredit(tx, id, effects.credit, effects.at);
    });
  }

  async pendingCredit(claimId: string): Promise<PendingCredit | null> {
    const row = await this.prisma.walletOperation.findFirst({
      where: { claimId, purpose: 'claim_credit', status: 'pending' },
    });
    if (!row) return null;
    return {
      id: row.id,
      claimId,
      idempotencyKey: row.idempotencyKey,
      holder: { kind: row.walletOwnerKind, id: row.walletOwnerId },
      amount: row.amount,
      label: row.label,
      sessionId: row.sessionId ?? '',
      createdBy: row.createdBy ?? '',
    };
  }

  async settleCredit(
    operationId: string,
    outcome: {
      status: 'succeeded' | 'failed';
      transactionId: string | null;
      failureCode: string | null;
      at: Date;
    },
  ): Promise<void> {
    await this.prisma.walletOperation.updateMany({
      where: { id: operationId, status: 'pending' },
      data: {
        status: outcome.status,
        walletTransactionId: outcome.transactionId,
        failureCode: outcome.failureCode,
        completedAt: outcome.at,
      },
    });
  }
}

/** Repasse gratuite : séance à 0 FCFA en fin de programme, « à affecter » (R-RC-03). */
async function insertRedo(tx: Tx, claimId: string, redo: NewRedoSession, at: Date): Promise<void> {
  const last = await tx.session.aggregate({ where: { programId: redo.programId }, _max: { rank: true } });
  await tx.session.create({
    data: {
      id: redo.id,
      programId: redo.programId,
      rank: (last._max.rank ?? 0) + 1,
      communeKey: redo.communeKey,
      scheduledStart: redo.start,
      scheduledEnd: redo.end,
      price: 0,
      freeRedoOfClaimId: claimId,
      createdAt: at,
      updatedAt: at,
    },
  });
}

/** Crédit à verser au wallet, clé fixe (RV-81). */
async function insertCredit(tx: Tx, claimId: string, credit: NewClaimCredit, at: Date): Promise<void> {
  await tx.walletOperation.create({
    data: {
      id: credit.id,
      kind: 'credit',
      purpose: 'claim_credit',
      idempotencyKey: credit.idempotencyKey,
      walletOwnerKind: credit.holder.kind,
      walletOwnerId: credit.holder.id,
      amount: credit.amount,
      label: credit.label,
      sessionId: credit.sessionId,
      claimId,
      createdBy: credit.createdBy,
      createdAt: at,
    },
  });
}
