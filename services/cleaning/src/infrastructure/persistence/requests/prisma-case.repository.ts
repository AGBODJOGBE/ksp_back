import { type Prisma } from '../../../../prisma/generated';
import { ConcurrentUpdateError } from '../../../application/agents/agent.ports';
import { type Changes, type IdGenerator } from '../../../application/ports';
import {
  type CaseFilter,
  type CaseRecord,
  type CaseRepository,
  type CaseWrites,
  type DeadlineCandidates,
  type DirectPaymentRecord,
  type Owner,
  type ProgramAmendmentWrite,
  type ProgramRenewalWrite,
  type VisitListFilter,
  type WalletOperationRecord,
} from '../../../application/requests/requests.ports';
import { type Page, type PageRequest } from '../../../application/shared/input';
import { type PrismaService } from '../../prisma/prisma.service';
import { isUuid } from '../agents/agent-rows';
import { cursorFilter, pageArgs, toPage, translateUniqueViolation, type Tx, writeChanges } from '../changes';
import { placeData } from './prisma-client-places.repository';
import {
  caseInclude,
  caseOf,
  type CaseRow,
  feeData,
  quoteData,
  requestData,
  revisionData,
  visitData,
} from './case-rows';

/** Statuts enregistrés qui peuvent être « ouverts » (R-DM-04, statut effectif lu ensuite). */
const OPEN_STATUSES = [
  'awaiting_visit_fee',
  'visit_to_schedule',
  'visit_scheduled',
  'visit_missed',
  'visit_done',
  'quote_sent',
] as const;
const CLOSED_STATUSES = ['declined', 'expired', 'cancelled', 'rejected'] as const;
/** Clé du verrou consultatif de la tâche des échéances du dossier (deux répliques). */
export const CASE_DEADLINES_LOCK_KEY = 7_311_044;

function walletOperationOf(row: Prisma.WalletOperationGetPayload<object>): WalletOperationRecord {
  return {
    id: row.id,
    kind: row.kind,
    purpose: row.purpose as WalletOperationRecord['purpose'],
    idempotencyKey: row.idempotencyKey,
    attempt: row.attempt,
    holder: { kind: row.walletOwnerKind, id: row.walletOwnerId },
    amount: row.amount,
    label: row.label,
    requestId: row.requestId ?? '',
    visitFeeId: row.visitFeeId ?? '',
    status: row.status,
    walletTransactionId: row.walletTransactionId,
    failureCode: row.failureCode,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

function directPaymentOf(row: Prisma.DirectPaymentGetPayload<object>): DirectPaymentRecord {
  return {
    id: row.id,
    paymentRequestId: row.paymentRequestId,
    idempotencyKey: row.idempotencyKey,
    payer: { kind: row.payerKind, id: row.payerId },
    amount: row.amount,
    requestId: row.requestId ?? '',
    visitFeeId: row.visitFeeId ?? '',
    status: row.status,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

/**
 * Dossiers du lot C. Un dossier est réécrit d'un bloc dans une transaction : version de la demande
 * contrôlée (verrou optimiste), puis frais, visites, révisions, devis et réactivations, dans un ordre
 * qui respecte les index partiels (une visite vivante, une révision ouverte, un devis envoyé, une
 * réactivation en attente par demande) : les lignes existantes sont mises à jour avant la création
 * des nouvelles, et une ligne qui quitte l'état unique avant celle qui y entre.
 */
export class PrismaCaseRepository implements CaseRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ids: IdGenerator,
  ) {}

  private async findBy(where: Prisma.CleaningRequestWhereInput): Promise<CaseRecord | null> {
    const row = await this.prisma.cleaningRequest.findFirst({ where, include: caseInclude });
    return row ? caseOf(row) : null;
  }

  findCase(requestId: string): Promise<CaseRecord | null> {
    return isUuid(requestId) ? this.findBy({ id: requestId }) : Promise.resolve(null);
  }

  findCaseByQuote(quoteId: string): Promise<CaseRecord | null> {
    return isUuid(quoteId) ? this.findBy({ quotes: { some: { id: quoteId } } }) : Promise.resolve(null);
  }

  findCaseByVisit(visitId: string): Promise<CaseRecord | null> {
    return isUuid(visitId) ? this.findBy({ visits: { some: { id: visitId } } }) : Promise.resolve(null);
  }

  async listCases(filter: CaseFilter, page: PageRequest): Promise<Page<CaseRecord>> {
    const where: Prisma.CleaningRequestWhereInput = {
      ...(filter.owner ? { ownerKind: filter.owner.kind, ownerId: filter.owner.id } : {}),
      ...(filter.statuses ? { status: { in: filter.statuses } } : {}),
      ...(filter.zones && filter.zones !== 'all' ? { communeKey: { in: filter.zones } } : {}),
      ...(filter.communeKey ? { communeKey: filter.communeKey } : {}),
      ...(filter.placeId ? { placeId: filter.placeId } : {}),
      ...(filter.search ? { number: { contains: filter.search, mode: 'insensitive' as const } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.cleaningRequest.findMany({
        where: { ...where, ...cursorFilter(page) },
        include: caseInclude,
        ...pageArgs(page),
      }),
      this.prisma.cleaningRequest.count({ where }),
    ]);
    const slice = toPage(rows, page.limit);
    return { items: slice.items.map(caseOf), nextCursor: slice.nextCursor, total };
  }

  async openCandidates(owner: Owner): Promise<CaseRecord[]> {
    const rows = await this.prisma.cleaningRequest.findMany({
      where: { ownerKind: owner.kind, ownerId: owner.id, status: { in: [...OPEN_STATUSES] } },
      include: caseInclude,
    });
    return rows.map(caseOf);
  }

  async listVisits(filter: VisitListFilter, page: PageRequest) {
    const where: Prisma.VisitWhereInput = {
      scheduledStart: { gte: filter.from, lt: filter.to },
      ...(filter.statuses ? { status: { in: filter.statuses as never } } : {}),
      ...(filter.zones !== 'all' ? { request: { communeKey: { in: filter.zones } } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.visit.findMany({
        where: { ...where, ...cursorFilter(page) },
        include: { request: { include: caseInclude } },
        ...pageArgs(page),
      }),
      this.prisma.visit.count({ where }),
    ]);
    const slice = toPage(rows, page.limit);
    return {
      items: slice.items.map((row) => {
        const record = caseOf(row.request as CaseRow);
        return { visit: record.visits.find((visit) => visit.id === row.id)!, request: record.request };
      }),
      nextCursor: slice.nextCursor,
      total,
    };
  }

  async insertCase(record: CaseRecord, writes: CaseWrites): Promise<string> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await writeChanges(tx, writes.changes, () => this.ids.next());
        const { request } = record;
        const created = await tx.cleaningRequest.create({
          data: { id: request.id, ...requestData(request), createdAt: request.createdAt, version: 0 },
          select: { number: true },
        });
        if (request.items.length) {
          await tx.requestItem.createMany({
            data: request.items.map((item) => ({
              requestId: request.id,
              offerId: item.offerId,
              tariffVersionId: item.tariffVersionId,
            })),
          });
        }
        await this.writeChildren(
          tx,
          { ...record, fees: [], visits: [], revisions: [], quotes: [], reactivations: [] },
          record,
          writes,
        );
        return created.number;
      });
    } catch (error) {
      throw translateUniqueViolation(error);
    }
  }

  async saveCase(record: CaseRecord, expectedVersion: number, writes: CaseWrites): Promise<void> {
    try {
      await this.prisma.$transaction(
        async (tx) => {
          await writeChanges(tx, writes.changes, () => this.ids.next());
          const { count } = await tx.cleaningRequest.updateMany({
            where: { id: record.request.id, version: expectedVersion },
            data: { ...requestData(record.request), version: { increment: 1 } },
          });
          if (count !== 1) throw new ConcurrentUpdateError();
          const before = await tx.cleaningRequest.findUniqueOrThrow({
            where: { id: record.request.id },
            include: caseInclude,
          });
          await this.writeChildren(tx, caseOf(before), record, writes);
        },
        { maxWait: 10_000, timeout: 20_000 },
      );
    } catch (error) {
      if (error instanceof ConcurrentUpdateError) throw error;
      throw translateUniqueViolation(error);
    }
  }

  private async writeChildren(
    tx: Tx,
    before: CaseRecord,
    after: CaseRecord,
    writes: CaseWrites,
  ): Promise<void> {
    const requestId = after.request.id;
    const now = after.request.updatedAt;
    const known = <T extends { id: string }>(items: readonly T[]) => new Set(items.map((item) => item.id));

    // Frais : ceux qui quittent « à payer » d'abord (un seul à payer par demande).
    const fees = known(before.fees);
    const feeOrder = [...after.fees].sort(
      (a, b) => Number(a.status === 'awaiting_payment') - Number(b.status === 'awaiting_payment'),
    );
    for (const fee of feeOrder) {
      if (fees.has(fee.id))
        await tx.visitFee.update({ where: { id: fee.id }, data: { ...feeData(fee), updatedAt: now } });
    }
    for (const fee of feeOrder) {
      if (!fees.has(fee.id)) {
        await tx.visitFee.create({
          data: { id: fee.id, requestId, ...feeData(fee), createdAt: now, updatedAt: now },
        });
      }
    }

    // Visites : retirées, puis mises à jour, puis créées (une seule vivante par demande).
    if (writes.removedVisitIds?.length) {
      await tx.visit.deleteMany({ where: { id: { in: writes.removedVisitIds }, requestId } });
    }
    const visits = known(before.visits);
    for (const visit of after.visits) {
      if (visits.has(visit.id) && !writes.removedVisitIds?.includes(visit.id)) {
        await tx.visit.update({
          where: { id: visit.id },
          data: { ...visitData(visit), updatedAt: now, version: { increment: 1 } },
        });
      }
    }
    for (const visit of after.visits) {
      if (!visits.has(visit.id)) {
        await tx.visit.create({
          data: {
            id: visit.id,
            requestId,
            ...visitData(visit),
            createdBy: visit.createdBy,
            createdAt: visit.createdAt,
            updatedAt: now,
          },
        });
      }
    }
    const visitIds = known(after.visits);

    // Révisions retenues : la révision close avant la nouvelle ouverte.
    const revisions = known(before.revisions);
    for (const revision of after.revisions) {
      if (revisions.has(revision.id))
        await tx.retainedValues.update({
          where: { id: revision.id },
          data: revisionData(revision, visitIds),
        });
    }
    for (const revision of after.revisions) {
      if (!revisions.has(revision.id)) {
        await tx.retainedValues.create({
          data: {
            id: revision.id,
            requestId,
            ...revisionData(revision, visitIds),
            createdAt: revision.createdAt,
          },
        });
      }
    }
    const revisionIds = new Map(after.revisions.map((revision) => [revision.revision, revision.id]));

    // Devis : celui qui quitte « envoyé » avant celui qui y entre.
    const quotes = known(before.quotes);
    const quoteOrder = [...after.quotes].sort(
      (a, b) => Number(a.status === 'sent') - Number(b.status === 'sent'),
    );
    for (const quote of quoteOrder) {
      const data = quoteData(quote, revisionIds.get(quote.retainedRevision) ?? null);
      if (quotes.has(quote.id))
        await tx.quote.update({ where: { id: quote.id }, data: { ...data, lockVersion: { increment: 1 } } });
      else
        await tx.quote.create({
          data: {
            id: quote.id,
            requestId,
            ...data,
            kind: quote.kind,
            programId: quote.programId,
            createdBy: quote.createdBy,
            createdAt: quote.createdAt,
          },
        });
    }

    // Réactivations : la décision avant une nouvelle demande en attente.
    const reactivations = known(before.reactivations);
    for (const item of after.reactivations) {
      const data = {
        status: item.status,
        decidedAt: item.decidedAt,
        decidedBy: item.decidedBy,
        reason: item.reason,
      };
      if (reactivations.has(item.id)) await tx.requestReactivation.update({ where: { id: item.id }, data });
    }
    for (const item of after.reactivations) {
      if (!reactivations.has(item.id)) {
        await tx.requestReactivation.create({
          data: {
            id: item.id,
            requestId,
            requestedBy: item.requestedBy,
            requestedAt: item.requestedAt,
            status: item.status,
            decidedAt: item.decidedAt,
            decidedBy: item.decidedBy,
            reason: item.reason,
          },
        });
      }
    }

    for (const op of writes.walletOperations ?? []) {
      await tx.walletOperation.create({
        data: {
          id: op.id,
          kind: op.kind,
          purpose: op.purpose,
          idempotencyKey: op.idempotencyKey,
          attempt: op.attempt,
          walletOwnerKind: op.holder.kind,
          walletOwnerId: op.holder.id,
          amount: op.amount,
          label: op.label,
          requestId: op.requestId,
          visitFeeId: op.visitFeeId,
          status: op.status,
          walletTransactionId: op.walletTransactionId,
          createdBy: op.createdBy,
          createdAt: op.createdAt,
        },
      });
    }
    for (const payment of writes.directPayments ?? []) {
      await tx.directPayment.create({
        data: {
          id: payment.id,
          idempotencyKey: payment.idempotencyKey,
          purpose: 'visit_fee',
          payerKind: payment.payer.kind,
          payerId: payment.payer.id,
          amount: payment.amount,
          requestId: payment.requestId,
          visitFeeId: payment.visitFeeId,
          status: payment.status,
          expiresAt: payment.expiresAt,
          createdAt: payment.createdAt,
        },
      });
    }

    if (writes.place) {
      const { record: place, expectedVersion } = writes.place;
      const { count } = await tx.place.updateMany({
        where: { id: place.id, version: expectedVersion },
        data: { ...placeData(place), version: { increment: 1 } },
      });
      if (count !== 1) throw new ConcurrentUpdateError();
    }

    if (writes.programRenewal) await this.writeRenewal(tx, writes.programRenewal);
    if (writes.programAmendment) await this.writeAmendment(tx, requestId, writes.programAmendment);

    if (writes.program) {
      const program = writes.program;
      const created = await tx.program.create({
        data: {
          id: program.id,
          requestId: program.requestId,
          quoteId: program.quoteId,
          ownerKind: program.owner.kind,
          ownerId: program.owner.id,
          payerKind: program.payerKind,
          placeId: program.placeId,
          communeKey: program.communeKey,
          sessionPrice: program.sessionPrice,
          teamSize: program.teamSize,
          durationMinutes: program.durationMinutes,
          schedulePlan: program.schedulePlan as unknown as Prisma.InputJsonValue,
          visitFeeToDeduct: program.visitFeeToDeduct,
          renewalOfProgramId: program.renewalOfProgramId ?? null,
          createdAt: program.createdAt,
          updatedAt: program.createdAt,
        },
        select: { number: true },
      });
      await tx.session.createMany({
        data: program.sessions.map((session) => ({
          id: session.id,
          programId: program.id,
          rank: session.rank,
          communeKey: program.communeKey,
          scheduledStart: session.scheduledStart,
          scheduledEnd: session.scheduledEnd,
          price: session.price,
          visitFeeDeducted: session.visitFeeDeducted,
          createdAt: program.createdAt,
          updatedAt: program.createdAt,
        })),
      });
      if (writes.programEvents) {
        await writeChanges(tx, { events: writes.programEvents(created.number), audit: [] }, () =>
          this.ids.next(),
        );
      }
    }
  }

  /**
   * Piste P — R-PG-07 : proposition (jamais sur un programme déjà renouvelé), puis réponse du client
   * sur la proposition en cours. Une ligne qui n'est plus dans l'état attendu : écriture concurrente.
   */
  private async writeRenewal(tx: Tx, renewal: ProgramRenewalWrite): Promise<void> {
    const { count } =
      renewal.status === 'proposed'
        ? await tx.program.updateMany({
            where: {
              id: renewal.programId,
              renewedBy: { is: null },
              ...(renewal.onlyIfNone
                ? { renewalStatus: null }
                : { OR: [{ renewalStatus: null }, { renewalStatus: { not: 'accepted' } }] }),
            },
            data: {
              renewalStatus: 'proposed',
              renewalProposedAt: renewal.at,
              renewalRespondedAt: null,
              renewalRespondedBy: null,
            },
          })
        : await tx.program.updateMany({
            where: { id: renewal.programId, renewalStatus: 'proposed' },
            data: {
              renewalStatus: renewal.status,
              renewalRespondedAt: renewal.at,
              renewalRespondedBy: renewal.by,
            },
          });
    if (count !== 1) throw new ConcurrentUpdateError();
  }

  /**
   * Piste P — R-PG-06 : avenant accepté, sous le verrou du programme (le même que les décisions du
   * lot E). Le programme et chaque séance changée sont écrits sous contrôle de version ; une séance
   * démarrée, close ou payée entre-temps fait échouer l'écriture entière.
   */
  private async writeAmendment(tx: Tx, requestId: string, amendment: ProgramAmendmentWrite): Promise<void> {
    const { programId, at } = amendment;
    await tx.$queryRaw`SELECT id FROM programs WHERE id = ${programId}::uuid FOR UPDATE`;
    const program = await tx.program.updateMany({
      where: {
        id: programId,
        version: amendment.expectedVersion,
        status: { in: ['confirmed', 'in_progress'] },
      },
      data: {
        sessionPrice: amendment.sessionPrice,
        teamSize: amendment.teamSize,
        durationMinutes: amendment.durationMinutes,
        schedulePlan: amendment.schedulePlan as Prisma.InputJsonValue,
        updatedAt: at,
        version: { increment: 1 },
      },
    });
    if (program.count !== 1) throw new ConcurrentUpdateError();
    for (const session of amendment.sessions) {
      const updated = await tx.session.updateMany({
        where: {
          id: session.id,
          programId,
          version: session.version,
          status: { in: ['to_assign', 'assigned', 'suspended'] },
          paymentStatus: 'not_due',
        },
        data: {
          price: session.price,
          scheduledEnd: session.scheduledEnd,
          ...(session.release ? { status: 'to_assign' as const } : {}),
          updatedAt: at,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw new ConcurrentUpdateError();
    }
    const released = amendment.sessions.filter((session) => session.release).map((session) => session.id);
    if (released.length) {
      await tx.assignment.updateMany({
        where: {
          sessionId: { in: released },
          status: { in: ['proposed', 'pending_confirmation', 'confirmed'] },
        },
        data: {
          status: 'removed',
          isLead: false,
          removedAt: at,
          removedBy: amendment.by,
          removalReason: 'amendment',
        },
      });
    }
    if (amendment.addedSessions.length) {
      await tx.session.createMany({
        data: amendment.addedSessions.map((session) => ({
          id: session.id,
          programId,
          rank: session.rank,
          communeKey: amendment.communeKey,
          scheduledStart: session.scheduledStart,
          scheduledEnd: session.scheduledEnd,
          price: session.price,
          visitFeeDeducted: 0,
          createdAt: at,
          updatedAt: at,
        })),
      });
    }
    if (amendment.addedItems.length) {
      await tx.requestItem.createMany({
        data: amendment.addedItems.map((item) => ({
          requestId,
          offerId: item.offerId,
          tariffVersionId: item.tariffVersionId,
        })),
        skipDuplicates: true,
      });
    }
  }

  async proposeRenewalWithoutQuote(programId: string, at: Date, changes: Changes): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.program.updateMany({
        where: { id: programId, renewalStatus: null, renewedBy: { is: null } },
        data: { renewalStatus: 'proposed', renewalProposedAt: at },
      });
      if (count !== 1) return false;
      await writeChanges(tx, changes, () => this.ids.next());
      return true;
    });
  }

  async walletOperations(requestId: string): Promise<WalletOperationRecord[]> {
    const rows = await this.prisma.walletOperation.findMany({
      where: { requestId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(walletOperationOf);
  }

  async stalePendingWalletOperations(before: Date, limit: number): Promise<WalletOperationRecord[]> {
    const rows = await this.prisma.walletOperation.findMany({
      where: {
        status: 'pending',
        purpose: { in: ['visit_fee', 'visit_fee_refund'] },
        createdAt: { lt: before },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map(walletOperationOf);
  }

  async completeWalletOperation(
    id: string,
    outcome: {
      status: 'succeeded' | 'failed';
      walletTransactionId: string | null;
      failureCode: string | null;
    },
    at: Date,
  ): Promise<boolean> {
    const { count } = await this.prisma.walletOperation.updateMany({
      where: { id, status: 'pending' },
      data: { ...outcome, completedAt: at },
    });
    return count === 1;
  }

  async directPayments(requestId: string): Promise<DirectPaymentRecord[]> {
    const rows = await this.prisma.directPayment.findMany({
      where: { requestId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(directPaymentOf);
  }

  async findDirectPaymentByPaymentId(paymentRequestId: string): Promise<DirectPaymentRecord | null> {
    if (!isUuid(paymentRequestId)) return null;
    const row = await this.prisma.directPayment.findUnique({ where: { paymentRequestId } });
    return row ? directPaymentOf(row) : null;
  }

  async updateDirectPayment(
    id: string,
    patch: Partial<Pick<DirectPaymentRecord, 'status' | 'paymentRequestId' | 'expiresAt' | 'completedAt'>>,
  ): Promise<void> {
    await this.prisma.directPayment.update({ where: { id }, data: patch });
  }

  async awaitingFeeRequestIds(owner: Owner): Promise<string[]> {
    const rows = await this.prisma.cleaningRequest.findMany({
      where: { ownerKind: owner.kind, ownerId: owner.id, status: 'awaiting_visit_fee' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  async organizationStanding(
    organizationId: string,
  ): Promise<{ suspended: boolean; unpaidInvoices: number }> {
    const [standing, unpaidInvoices] = await Promise.all([
      this.prisma.organizationStanding.findUnique({ where: { organizationId } }),
      this.prisma.organizationInvoice.count({ where: { organizationId, standing: 'overdue' } }),
    ]);
    return { suspended: standing?.suspended ?? false, unpaidInvoices };
  }

  async deadlineCandidates(now: Date, reminderDays: number, limit: number): Promise<DeadlineCandidates> {
    const ids = (rows: { requestId: string }[]) => [...new Set(rows.map((row) => row.requestId))];
    const [unpaid, expired, reminders, live] = await Promise.all([
      this.prisma.visitFee.findMany({
        where: { status: 'awaiting_payment', dueAt: { lte: now }, request: { status: 'awaiting_visit_fee' } },
        select: { requestId: true },
        take: limit,
      }),
      this.prisma.quote.findMany({
        where: { status: 'sent', validUntil: { lte: now } },
        select: { requestId: true },
        take: limit,
      }),
      reminderDays > 0
        ? this.prisma.quote.findMany({
            where: {
              status: 'sent',
              expiryRemindedAt: null,
              validUntil: { gt: now, lte: new Date(now.getTime() + reminderDays * 86_400_000) },
            },
            select: { requestId: true },
            take: limit,
          })
        : Promise.resolve([]),
      this.prisma.visit.findMany({
        where: {
          status: { in: ['scheduled', 'in_progress'] },
          request: { status: { in: [...CLOSED_STATUSES] } },
        },
        select: { requestId: true },
        take: limit,
      }),
    ]);
    return {
      unpaidFeeRequestIds: ids(unpaid),
      expiredQuoteRequestIds: ids(expired),
      reminderQuoteRequestIds: ids(reminders),
      closedWithLiveVisitRequestIds: ids(live),
    };
  }

  /**
   * Verrou consultatif de transaction : tenu par la connexion de la transaction pendant tout le
   * passage, rendu à sa fin (même en cas d'erreur). Une seconde réplique ne l'obtient pas et passe.
   */
  async withDeadlinesLock(work: () => Promise<void>): Promise<boolean> {
    return this.prisma.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<
          { locked: boolean }[]
        >`SELECT pg_try_advisory_xact_lock(${CASE_DEADLINES_LOCK_KEY}) AS locked`;
        if (!row?.locked) return false;
        await work();
        return true;
      },
      { maxWait: 10_000, timeout: 10 * 60_000 },
    );
  }

  async markProcessed(eventId: string, consumer: string): Promise<boolean> {
    try {
      await this.prisma.processedEvent.create({ data: { eventId, consumer } });
      return true;
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'P2002') return false;
      throw error;
    }
  }
}
