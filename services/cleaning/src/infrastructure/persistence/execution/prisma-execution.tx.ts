import { ConcurrentUpdateError } from '../../../application/agents/agent.ports';
import {
  type DirectPaymentRecord,
  type ExecutionReader,
  type ExecutionSettings,
  type ExecutionTx,
  type NewDirectPayment,
  type NewWalletOperation,
  type ProgramPatch,
  type ProgramRecord,
  type SessionPatch,
  type SessionRecord,
  type WalletOperationRecord,
} from '../../../application/execution/execution.ports';
import { type OrganizationTransaction } from '../../../application/organizations/organizations.ports';
import { type Changes, type Clock, type IdGenerator } from '../../../application/ports';
import { type ProgramStatus } from '../../../domain/programs/program-status';
import { type ActiveCause, type SuspensionCauseCode } from '../../../domain/programs/suspension';
import { type Reschedule } from '../../../domain/sessions/reschedule';
import { type Incident } from '../../../domain/sessions/session';
import { isUuid } from '../agents/agent-rows';
import { json, type Tx, writeChanges } from '../changes';
import { lockOrganization } from '../organizations/organization-lock';
import { PrismaOrganizationTransaction } from '../organizations/prisma-organization.tx';
import { checklistJson, PROGRAM_INCLUDE, SESSION_INCLUDE, toProgram, toSession } from './execution-rows';

/** Affectations en vigueur d'une séance (retirées à l'annulation, la suspension ou le report). */
const IN_FORCE = ['proposed', 'pending_confirmation', 'confirmed'] as const;

/** Lectures du lot E, sur le client Prisma ou dans une transaction. */
export class PrismaExecutionReader implements ExecutionReader {
  constructor(
    protected readonly client: Tx,
    protected readonly clock: Clock,
  ) {}

  async program(id: string): Promise<ProgramRecord | null> {
    if (!isUuid(id)) return null;
    const row = await this.client.program.findUnique({ where: { id }, include: PROGRAM_INCLUDE });
    if (!row) return null;
    const [stats, pending] = await Promise.all([this.programStats(id), this.pendingCancellation(id)]);
    return toProgram(row, stats, pending);
  }

  protected async programStats(programId: string) {
    const [all, completed, range] = await Promise.all([
      this.client.session.count({ where: { programId } }),
      this.client.session.count({ where: { programId, status: 'completed' } }),
      this.client.session.aggregate({
        where: { programId, status: { not: 'cancelled' } },
        _min: { scheduledStart: true },
        _max: { scheduledStart: true },
      }),
    ]);
    return {
      sessionsCount: all,
      sessionsCompleted: completed,
      firstSessionAt: range._min.scheduledStart,
      lastSessionAt: range._max.scheduledStart,
    };
  }

  /** Auteur et date de la demande d'arrêt par KSP : journal d'audit (program.cancel_requested). */
  protected async pendingCancellation(programId: string) {
    const entry = await this.client.auditEntry.findFirst({
      where: { entityType: 'program', entityId: programId, action: 'program.cancel_requested' },
      orderBy: { at: 'desc' },
    });
    return entry ? { requestedBy: entry.actorId, requestedAt: entry.at } : null;
  }

  async session(id: string): Promise<SessionRecord | null> {
    if (!isUuid(id)) return null;
    const row = await this.client.session.findUnique({ where: { id }, include: SESSION_INCLUDE });
    return row ? toSession(row, this.clock.now()) : null;
  }

  async programSessions(programId: string): Promise<SessionRecord[]> {
    if (!isUuid(programId)) return [];
    const rows = await this.client.session.findMany({
      where: { programId },
      include: SESSION_INCLUDE,
      orderBy: { rank: 'asc' },
    });
    const now = this.clock.now();
    return rows.map((row) => toSession(row, now));
  }

  async walletOperations(sessionId: string): Promise<WalletOperationRecord[]> {
    const rows = await this.client.walletOperation.findMany({
      where: { sessionId, purpose: 'session_payment' },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toWalletOperation);
  }

  async directPayments(sessionId: string): Promise<DirectPaymentRecord[]> {
    const rows = await this.client.directPayment.findMany({
      where: { sessionId, purpose: 'session_payment' },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toDirectPayment);
  }

  async settings(): Promise<ExecutionSettings> {
    const row = await this.client.cleaningSettings.findUniqueOrThrow({ where: { id: 1 } });
    const common = Array.isArray(row.commonChecklist)
      ? (row.commonChecklist as { code: string; label: string; order?: number }[])
      : [];
    return {
      freeCancellationHours: row.freeCancellationHours,
      maxReschedulesPerMonth: row.maxReschedulesPerMonth,
      lateCancellationFeePct: row.lateCancellationFeePct,
      sessionPaymentGraceHours: row.sessionPaymentGraceHours,
      overdueSessionsBeforeSuspension: row.overdueSessionsBeforeSuspension,
      balanceGuarantee: row.balanceGuarantee,
      firstSessionLeadHours: row.firstSessionLeadHours,
      maxPhotosPerType: row.maxPhotosPerType,
      claimWindowHours: row.claimWindowHours,
      arrivalAlertMeters: row.arrivalAlertMeters,
      arrivalMaxAdvanceMinutes: row.arrivalMaxAdvanceMinutes,
      customerWaitMinutes: row.customerWaitMinutes,
      commonChecklist: [...common]
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((point) => ({ code: point.code, label: point.label })),
      deductVisitFee: row.deductVisitFee,
    };
  }

  async holidays(from: Date, to: Date): Promise<string[]> {
    const rows = await this.client.publicHoliday.findMany({
      where: { active: true, date: { gte: new Date(from.getTime() - 86_400_000), lte: to } },
      select: { date: true },
    });
    return rows.map((row) => row.date.toISOString().slice(0, 10));
  }
}

export function toWalletOperation(row: {
  id: string;
  idempotencyKey: string;
  attempt: number;
  sessionId: string | null;
  amount: number;
  status: WalletOperationRecord['status'];
  walletTransactionId: string | null;
  failureCode: string | null;
  createdAt: Date;
}): WalletOperationRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    attempt: row.attempt,
    sessionId: row.sessionId,
    amount: row.amount,
    status: row.status,
    walletTransactionId: row.walletTransactionId,
    failureCode: row.failureCode,
    createdAt: row.createdAt,
  };
}

/**
 * La page de paiement (checkoutUrl) n'est pas gardée en base : elle se relit chez payment avec la
 * même clé (CreatePaymentRequest rend la page encore ouverte).
 */
export function toDirectPayment(row: {
  id: string;
  paymentRequestId: string | null;
  idempotencyKey: string;
  sessionId: string | null;
  amount: number;
  status: DirectPaymentRecord['status'];
  expiresAt: Date | null;
  createdAt: Date;
}): DirectPaymentRecord {
  return {
    id: row.id,
    paymentRequestId: row.paymentRequestId,
    idempotencyKey: row.idempotencyKey,
    sessionId: row.sessionId,
    amount: row.amount,
    status: row.status,
    checkoutUrl: null,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/** Écritures du lot E dans une transaction ouverte par le dépôt. */
export class PrismaExecutionTx extends PrismaExecutionReader implements ExecutionTx {
  constructor(
    private readonly tx: Tx,
    clock: Clock,
    private readonly ids: IdGenerator,
  ) {
    super(tx, clock);
  }

  async lockProgram(programId: string): Promise<void> {
    if (!isUuid(programId)) return;
    await this.tx.$queryRaw`SELECT id FROM programs WHERE id = ${programId}::uuid FOR UPDATE`;
  }

  async organization(organizationId: string): Promise<OrganizationTransaction> {
    await lockOrganization(this.tx, organizationId);
    return new PrismaOrganizationTransaction(this.tx, this, this.clock);
  }

  async updateSession(id: string, expectedVersion: number | null, patch: SessionPatch): Promise<void> {
    const data = sessionData(patch);
    const now = this.clock.now();
    const result = await this.tx.session.updateMany({
      where: { id, ...(expectedVersion === null ? {} : { version: expectedVersion }) },
      data: { ...data, updatedAt: now, version: { increment: 1 } },
    });
    if (result.count !== 1) throw new ConcurrentUpdateError();
  }

  async updateProgram(id: string, patch: ProgramPatch): Promise<void> {
    await this.tx.program.update({
      where: { id },
      data: {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.suspendedAt !== undefined ? { suspendedAt: patch.suspendedAt } : {}),
        ...(patch.visitFeeToDeduct !== undefined ? { visitFeeToDeduct: patch.visitFeeToDeduct } : {}),
        ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
        ...(patch.cancellationRequestReason !== undefined
          ? { cancellationReason: patch.cancellationRequestReason }
          : {}),
        ...(patch.cancellation
          ? {
              cancelledAt: patch.cancellation.at,
              cancelledBy: patch.cancellation.by,
              cancellationReason: patch.cancellation.reason,
              cancellationApprovedBy: patch.cancellation.approvedBy,
            }
          : {}),
        ...(patch.schedulePlan !== undefined ? { schedulePlan: json(patch.schedulePlan) } : {}),
        ...(patch.durationMinutes !== undefined ? { durationMinutes: patch.durationMinutes } : {}),
        updatedAt: this.clock.now(),
        version: { increment: 1 },
      },
    });
  }

  /** Cause ajoutée : historique et cache des causes actives (Program.suspensionCauses). */
  async addCause(
    programId: string,
    cause: ActiveCause,
    status?: { status: ProgramStatus; suspendedAt: Date | null },
  ): Promise<void> {
    await this.tx.programSuspensionCause.create({
      data: {
        id: this.ids.next(),
        programId,
        cause: cause.cause,
        since: cause.since,
        reason: cause.reason,
        decidedBy: cause.decidedBy,
      },
    });
    await this.refreshCauses(programId, status);
  }

  async liftCause(
    programId: string,
    cause: SuspensionCauseCode,
    at: Date,
    by: string | null,
    status?: { status: ProgramStatus; suspendedAt: Date | null },
  ): Promise<void> {
    await this.tx.programSuspensionCause.updateMany({
      where: { programId, cause, liftedAt: null },
      data: { liftedAt: at, liftedBy: by },
    });
    await this.refreshCauses(programId, status);
  }

  private async refreshCauses(
    programId: string,
    status?: { status: ProgramStatus; suspendedAt: Date | null },
  ): Promise<void> {
    const active = await this.tx.programSuspensionCause.findMany({
      where: { programId, liftedAt: null },
      orderBy: { since: 'asc' },
      select: { cause: true },
    });
    await this.tx.program.update({
      where: { id: programId },
      data: {
        suspensionCauses: [...new Set(active.map((row) => row.cause))],
        ...(status
          ? { status: status.status, suspendedAt: status.suspendedAt, updatedAt: this.clock.now() }
          : {}),
        ...(status ? { version: { increment: 1 } } : {}),
      },
    });
  }

  async rateAgents(agentIds: readonly string[], stars: number): Promise<void> {
    if (agentIds.length === 0) return;
    await this.tx.agent.updateMany({
      where: { id: { in: [...agentIds] } },
      data: { ratingSum: { increment: stars }, ratingCount: { increment: 1 } },
    });
  }

  async insertIncident(sessionId: string, incident: Incident): Promise<void> {
    await this.tx.sessionIncident.create({
      data: {
        id: incident.id,
        sessionId,
        kind: incident.category,
        note: incident.note,
        photoFileIds: incident.photoFileIds,
        reportedBy: incident.reportedBy,
        occurredAt: incident.occurredAt,
        decision: incident.decision,
      },
    });
  }

  async decideIncidents(sessionId: string, incidents: readonly Incident[]): Promise<void> {
    for (const incident of incidents) {
      await this.tx.sessionIncident.updateMany({
        where: { id: incident.id, sessionId, decision: 'pending' },
        data: { decision: incident.decision, decidedBy: incident.decidedBy, decidedAt: incident.decidedAt },
      });
    }
  }

  async insertReschedule(sessionId: string, reschedule: Reschedule): Promise<void> {
    await this.tx.sessionReschedule.create({
      data: {
        id: this.ids.next(),
        sessionId,
        previousStart: reschedule.previousStart,
        previousEnd: reschedule.previousEnd,
        newStart: reschedule.newStart,
        newEnd: reschedule.newEnd,
        requestedBy: reschedule.by,
        actorId: reschedule.actorId,
        reason: reschedule.reason,
        createdAt: reschedule.at,
      },
    });
  }

  async releaseAssignments(
    sessionIds: readonly string[],
    removal: { by: string | null; reason: string; at: Date },
    agentIds?: readonly string[],
  ): Promise<string[]> {
    if (sessionIds.length === 0) return [];
    const where = {
      sessionId: { in: [...sessionIds] },
      status: { in: [...IN_FORCE] },
      ...(agentIds ? { agentId: { in: [...agentIds] } } : {}),
    };
    const rows = await this.tx.assignment.findMany({ where, select: { agentId: true } });
    await this.tx.assignment.updateMany({
      where,
      data: {
        status: 'removed',
        isLead: false,
        removedAt: removal.at,
        removedBy: removal.by,
        removalReason: removal.reason,
      },
    });
    return [...new Set(rows.map((row) => row.agentId))].sort();
  }

  async blockedAgents(
    sessionId: string,
    agentIds: readonly string[],
    start: Date,
    end: Date,
  ): Promise<string[]> {
    const valid = agentIds.filter(isUuid);
    if (valid.length === 0) return [];
    await this.tx.$queryRaw`SELECT id FROM agents WHERE id = ANY(${valid}::uuid[]) ORDER BY id FOR UPDATE`;
    const own = await this.tx.assignment.findMany({
      where: { sessionId, agentId: { in: valid }, status: { in: [...IN_FORCE] } },
      select: { agentId: true, travelMinutes: true },
    });
    const travel = new Map(own.map((row) => [row.agentId, row.travelMinutes]));
    const [inactive, unavailable] = await Promise.all([
      this.tx.agent.findMany({
        where: { id: { in: valid }, status: { not: 'active' } },
        select: { id: true },
      }),
      this.tx.unavailability.findMany({
        where: { agentId: { in: valid }, startsAt: { lt: end }, endsAt: { gt: start } },
        select: { agentId: true },
      }),
    ]);
    const blocked = new Set([...inactive.map((row) => row.id), ...unavailable.map((row) => row.agentId)]);
    for (const agentId of valid) {
      const from = new Date(start.getTime() - (travel.get(agentId) ?? 0) * 60_000);
      const clash = await this.tx.assignment.count({
        where: {
          agentId,
          status: { in: [...IN_FORCE] },
          OR: [{ sessionId: { not: sessionId } }, { sessionId: null }],
          occupiedFrom: { lt: end },
          occupiedUntil: { gt: from },
        },
      });
      if (clash > 0) blocked.add(agentId);
    }
    return [...blocked].sort();
  }

  async moveAssignments(sessionId: string, start: Date, end: Date): Promise<void> {
    const rows = await this.tx.assignment.findMany({
      where: { sessionId, status: { in: [...IN_FORCE] } },
      select: { id: true, travelMinutes: true },
    });
    for (const row of rows) {
      await this.tx.assignment.update({
        where: { id: row.id },
        data: { occupiedFrom: new Date(start.getTime() - row.travelMinutes * 60_000), occupiedUntil: end },
      });
    }
  }

  async insertWalletOperation(operation: NewWalletOperation): Promise<void> {
    await this.tx.walletOperation.create({
      data: {
        id: operation.id,
        kind: 'debit',
        purpose: 'session_payment',
        idempotencyKey: operation.idempotencyKey,
        attempt: operation.attempt,
        walletOwnerKind: operation.walletOwnerKind,
        walletOwnerId: operation.walletOwnerId,
        amount: operation.amount,
        label: operation.label,
        requestId: operation.requestId,
        sessionId: operation.sessionId,
        createdAt: operation.createdAt,
      },
    });
  }

  async completeWalletOperation(
    id: string,
    result: {
      status: 'succeeded' | 'failed';
      walletTransactionId: string | null;
      failureCode: string | null;
      at: Date;
    },
  ): Promise<void> {
    await this.tx.walletOperation.update({
      where: { id },
      data: {
        status: result.status,
        walletTransactionId: result.walletTransactionId,
        failureCode: result.failureCode,
        completedAt: result.at,
      },
    });
  }

  async reopenWalletOperation(id: string, amount: number, at: Date): Promise<void> {
    await this.tx.walletOperation.update({
      where: { id },
      data: { status: 'pending', amount, failureCode: null, completedAt: null, createdAt: at },
    });
  }

  async insertDirectPayment(payment: NewDirectPayment): Promise<void> {
    await this.tx.directPayment.create({
      data: {
        id: payment.id,
        idempotencyKey: payment.idempotencyKey,
        purpose: 'session_payment',
        payerKind: payment.payerKind,
        payerId: payment.payerId,
        amount: payment.amount,
        requestId: payment.requestId,
        sessionId: payment.sessionId,
        expiresAt: payment.expiresAt,
        createdAt: payment.createdAt,
      },
    });
  }

  async updateDirectPayment(
    id: string,
    patch: Parameters<ExecutionTx['updateDirectPayment']>[1],
  ): Promise<void> {
    await this.tx.directPayment.update({
      where: { id },
      data: {
        ...(patch.paymentRequestId !== undefined ? { paymentRequestId: patch.paymentRequestId } : {}),
        ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
      },
    });
  }

  write(changes: Changes): Promise<void> {
    return writeChanges(this.tx, changes, () => this.ids.next());
  }
}

function sessionData(patch: SessionPatch) {
  const pick = <K extends keyof SessionPatch>(key: K) =>
    patch[key] !== undefined ? { [key]: patch[key] } : {};
  return {
    ...pick('status'),
    ...pick('scheduledStart'),
    ...pick('scheduledEnd'),
    ...pick('arrivedAt'),
    ...pick('arrivalGpsEncrypted'),
    ...(patch.arrivalDistanceM !== undefined ? { arrivalDistanceM: patch.arrivalDistanceM } : {}),
    ...pick('startedAt'),
    ...pick('completedAt'),
    ...(patch.checklist ? { checklist: checklistJson(patch.checklist) } : {}),
    ...pick('beforePhotoFileIds'),
    ...pick('afterPhotoFileIds'),
    ...pick('signatureFileId'),
    ...(patch.missed
      ? {
          missedCause: patch.missed.cause,
          missedAt: patch.missed.missedAt,
          waitStartedAt: patch.missed.waitStartedAt,
          calledAt: patch.missed.calledAt,
          missedPhotoFileId: patch.missed.photoFileId,
        }
      : {}),
    ...(patch.cancellation
      ? {
          cancelledAt: patch.cancellation.at,
          cancelledBy: patch.cancellation.by,
          cancelCause: patch.cancellation.cause,
          lateCancellation: patch.cancellation.late,
          changeReason: patch.cancellation.reason,
        }
      : {}),
    ...(patch.staffClosure
      ? {
          closedByStaff: true,
          closedBy: patch.staffClosure.closedBy,
          closedReason: patch.staffClosure.reason,
          presentAgentIds: patch.staffClosure.presentAgentIds,
        }
      : {}),
    ...pick('amountDue'),
    ...pick('visitFeeDeducted'),
    ...pick('paymentStatus'),
    ...(patch.dueBy !== undefined ? { paymentDueAt: patch.dueBy } : {}),
    ...pick('paidAt'),
    ...pick('invoiceId'),
    ...pick('catchUpSuggestedStart'),
    ...pick('remindedAt'),
    ...pick('balanceAlertedAt'),
    ...(patch.rating
      ? { rating: patch.rating.stars, ratingComment: patch.rating.comment, ratedAt: patch.rating.ratedAt }
      : {}),
    ...pick('staffingAlertLevel'),
  };
}
