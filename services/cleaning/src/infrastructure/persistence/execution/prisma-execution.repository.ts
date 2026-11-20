import {
  type DirectPaymentRecord,
  type DueSessionRef,
  type ExecutionRepository,
  type ExecutionTx,
  type OwnerKind,
  type ProgramFilter,
  type ProgramRecord,
  type SessionRecord,
  type WalletOperationRecord,
} from '../../../application/execution/execution.ports';
import { type Clock, type IdGenerator } from '../../../application/ports';
import { type Page } from '../../../application/shared/input';
import { type PrismaService } from '../../prisma/prisma.service';
import { isUuid } from '../agents/agent-rows';
import { type Tx } from '../changes';
import { SESSION_INCLUDE, toSession } from './execution-rows';
import {
  PrismaExecutionReader,
  PrismaExecutionTx,
  toDirectPayment,
  toWalletOperation,
} from './prisma-execution.tx';

/**
 * Dépôt du lot E : programmes, séances, paiements par séance. Une transaction attend au plus 10 s
 * son tour et dure au plus 20 s ; le verrou du programme (lockProgram) sérialise les décisions d'un
 * même programme (débit, retard, suspension, arrêt).
 */
export class PrismaExecutionRepository extends PrismaExecutionReader implements ExecutionRepository {
  constructor(
    private readonly prisma: PrismaService,
    clock: Clock,
    private readonly ids: IdGenerator,
  ) {
    super(prisma as unknown as Tx, clock);
  }

  transaction<T>(work: (tx: ExecutionTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => work(new PrismaExecutionTx(tx, this.clock, this.ids)), {
      maxWait: 10_000,
      timeout: 20_000,
    });
  }

  /** Programmes du plus récent au plus ancien (identifiants UUID v7). */
  async listPrograms(
    filter: ProgramFilter,
    page: { limit: number; cursor: string | null },
  ): Promise<Page<ProgramRecord>> {
    const where = {
      ...(filter.ownerKind && filter.ownerId ? { ownerKind: filter.ownerKind, ownerId: filter.ownerId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.communeKey ? { communeKey: filter.communeKey } : {}),
      ...(filter.payerKind ? { payerKind: filter.payerKind } : {}),
      ...(filter.q ? { number: { contains: filter.q, mode: 'insensitive' as const } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.program.findMany({
        where: { ...where, ...(page.cursor ? { id: { lt: page.cursor } } : {}) },
        orderBy: { id: 'desc' },
        take: page.limit + 1,
        select: { id: true },
      }),
      this.prisma.program.count({ where }),
    ]);
    const ids = rows.slice(0, page.limit).map((row) => row.id);
    const items = (await Promise.all(ids.map((id) => this.program(id)))).filter(
      (program): program is ProgramRecord => program !== null,
    );
    return { items, nextCursor: rows.length > page.limit ? ids.at(-1)! : null, total };
  }

  async sessionsPastDue(now: Date, limit: number): Promise<DueSessionRef[]> {
    const rows = await this.prisma.session.findMany({
      where: { paymentStatus: 'due', paymentDueAt: { lte: now } },
      orderBy: { paymentDueAt: 'asc' },
      take: limit,
      select: { id: true, programId: true },
    });
    return rows.map(ref);
  }

  async sessionsToWatch(now: Date, limit: number): Promise<DueSessionRef[]> {
    const rows = await this.prisma.session.findMany({
      where: {
        OR: [
          { status: 'to_assign', scheduledStart: { lte: new Date(now.getTime() + 48 * 3_600_000) } },
          {
            status: 'assigned',
            scheduledStart: { lte: new Date(now.getTime() - 3_600_000) },
            OR: [{ staffingAlertLevel: null }, { staffingAlertLevel: { not: 'agent_absent' } }],
          },
        ],
      },
      orderBy: { scheduledStart: 'asc' },
      take: limit,
      select: { id: true, programId: true },
    });
    return rows.map(ref);
  }

  async sessionsToRemind(until: Date, limit: number): Promise<DueSessionRef[]> {
    const rows = await this.prisma.session.findMany({
      where: {
        status: { in: ['to_assign', 'assigned'] },
        remindedAt: null,
        scheduledStart: { gt: this.clock.now(), lte: until },
      },
      orderBy: { scheduledStart: 'asc' },
      take: limit,
      select: { id: true, programId: true },
    });
    return rows.map(ref);
  }

  async sessionsAwaitingInvoice(limit: number): Promise<DueSessionRef[]> {
    const rows = await this.prisma.session.findMany({
      where: { paymentStatus: 'paid', invoiceId: null, program: { payerKind: 'individual' } },
      orderBy: { paidAt: 'asc' },
      take: limit,
      select: { id: true, programId: true },
    });
    return rows.map(ref);
  }

  async pendingWalletOperations(
    before: Date,
    limit: number,
  ): Promise<(WalletOperationRecord & { programId: string })[]> {
    const rows = await this.prisma.walletOperation.findMany({
      where: {
        status: 'pending',
        purpose: 'session_payment',
        createdAt: { lt: before },
        sessionId: { not: null },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: { session: { select: { programId: true } } },
    });
    return rows.map((row) => ({ ...toWalletOperation(row), programId: row.session!.programId }));
  }

  async sessionsAwaitingDebit(holder: { kind: OwnerKind; id: string }): Promise<DueSessionRef[]> {
    if (!isUuid(holder.id)) return [];
    const rows = await this.prisma.session.findMany({
      where: {
        paymentStatus: { in: ['due', 'overdue'] },
        program: { ownerKind: holder.kind, ownerId: holder.id, payerKind: 'individual' },
      },
      orderBy: [{ paymentDueAt: 'asc' }, { id: 'asc' }],
      select: { id: true, programId: true },
    });
    return rows.map(ref);
  }

  async directPayment(lookup: {
    paymentRequestId?: string;
    id?: string;
  }): Promise<DirectPaymentRecord | null> {
    const where = lookup.id
      ? isUuid(lookup.id)
        ? { id: lookup.id }
        : null
      : lookup.paymentRequestId && isUuid(lookup.paymentRequestId)
        ? { paymentRequestId: lookup.paymentRequestId }
        : null;
    if (!where) return null;
    const row = await this.prisma.directPayment.findFirst({ where });
    return row ? toDirectPayment(row) : null;
  }

  async walletOperationByTransaction(
    transactionId: string,
  ): Promise<(WalletOperationRecord & { purpose: string }) | null> {
    if (!isUuid(transactionId)) return null;
    const row = await this.prisma.walletOperation.findFirst({
      where: { walletTransactionId: transactionId },
    });
    return row ? { ...toWalletOperation(row), purpose: row.purpose } : null;
  }

  async agentSessions(agentId: string, from: Date, to: Date): Promise<SessionRecord[]> {
    if (!isUuid(agentId)) return [];
    const rows = await this.prisma.session.findMany({
      where: {
        scheduledStart: { gte: from, lt: to },
        assignments: { some: { agentId, status: { in: ['confirmed', 'pending_confirmation', 'proposed'] } } },
      },
      include: SESSION_INCLUDE,
      orderBy: { scheduledStart: 'asc' },
    });
    const now = this.clock.now();
    return rows.map((row) => toSession(row, now));
  }

  async walletOperationsFor(object: {
    type: 'cleaning_session' | 'cleaning_visit_fee';
    id: string;
  }): Promise<WalletOperationRecord[]> {
    if (!isUuid(object.id)) return [];
    const rows = await this.prisma.walletOperation.findMany({
      where:
        object.type === 'cleaning_session'
          ? { sessionId: object.id, purpose: 'session_payment' }
          : { requestId: object.id, purpose: 'visit_fee' },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toWalletOperation);
  }
}

const ref = (row: { id: string; programId: string }): DueSessionRef => ({
  sessionId: row.id,
  programId: row.programId,
});
