import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../prisma/generated';
import {
  type CaseChanges,
  type CaseDocumentData,
  type EvidenceActorType,
  type PageRequest,
  type RecoveryCaseRecord,
  type SaveOutcome,
} from '../../application/cases/ports';
import {
  type CallbackRecord,
  type CaseMoney,
  type CollectionRecord,
  type DisputeRecord,
  type MoneyStore,
  type MoneyWrites,
  type OfflinePaymentFilter,
  type OfflinePaymentRecord,
  type OverpaymentRefundRecord,
  type PaymentRequestRecord,
  type ReceiptMethod,
  type RemittanceFilter,
  type RemittanceRecord,
} from '../../application/money/money.ports';
import { type Holder, type PersonalData } from '../../application/ports';
import { type CaseStage, type StageGroup } from '../../domain/case';
import { type CollectionSource, type CommissionSettlement } from '../../domain/collection';
import { type DisputeReason, type DisputeResolution, type DisputeStatus } from '../../domain/dispute';
import { type OfflinePaymentSource, type OfflinePaymentStatus } from '../../domain/offline-payment';
import { PrismaService } from '../prisma/prisma.service';
import { UuidV7Generator } from '../system/system';
import { CASE_PERSONAL_DATA } from './prisma-cases.repository';
import { caseColumns, insertDocuments, isUniqueViolation, type Tx, writeChanges } from './prisma-case-rows';

/** Contextes de chiffrement (ADR-063) : texte d'une contestation, message d'une demande de rappel. */
export const disputeTextContext = (id: string) => `disputes.text:${id}`;
export const callbackNoteContext = (id: string) => `callback_requests.note:${id}`;

/** Version lue périmée : annule la transaction. */
class StaleWrite extends Error {}

/** Encaissement de même référence enregistré en même temps par une autre instance. */
function isDuplicateCollection(error: unknown): boolean {
  if (!isUniqueViolation(error)) return false;
  const target = (error as Prisma.PrismaClientKnownRequestError).meta?.['target'];
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
  return fields.some((field) => field === 'reference' || field.includes('collections_reference'));
}

type CollectionRow = Prisma.CollectionGetPayload<object>;
type PaymentRequestRow = Prisma.PaymentRequestGetPayload<object>;
type OfflinePaymentRow = Prisma.OfflinePaymentGetPayload<object>;
type DisputeRow = Prisma.DisputeGetPayload<object>;
type CallbackRow = Prisma.CallbackRequestGetPayload<object>;

function collectionOf(row: CollectionRow): CollectionRecord {
  return {
    id: row.id,
    caseId: row.caseId,
    source: row.source as CollectionSource,
    reference: row.reference,
    gross: row.gross,
    allocatedCosts: row.allocatedCosts,
    allocatedInterests: row.allocatedInterests,
    allocatedPrincipal: row.allocatedPrincipal,
    overpaid: row.overpaid,
    commissionBase: row.commissionBase,
    commission: row.commission,
    net: row.net,
    settlement: row.settlement as CommissionSettlement,
    stage: (row.stage as CaseStage | null) ?? null,
    stageGroup: row.stageGroup as StageGroup,
    dueBefore: row.dueBefore,
    rule: row.ruleId ? { id: row.ruleId, version: row.ruleVersion ?? 0 } : null,
    walletTransactionId: row.walletTransactionId,
    creditedAt: row.creditedAt,
    receipt: row.receiptMethod
      ? { method: row.receiptMethod as ReceiptMethod, reference: row.receiptReference ?? '' }
      : null,
    receiptDocumentId: row.receiptDocumentId,
    proofFileId: row.proofFileId,
    note: row.note,
    recordedBy: row.recordedBy,
    collectedAt: row.collectedAt,
    createdAt: row.createdAt,
  };
}

function collectionData(collection: CollectionRecord) {
  return {
    id: collection.id,
    caseId: collection.caseId,
    source: collection.source,
    reference: collection.reference,
    gross: collection.gross,
    allocatedCosts: collection.allocatedCosts,
    allocatedInterests: collection.allocatedInterests,
    allocatedPrincipal: collection.allocatedPrincipal,
    overpaid: collection.overpaid,
    commissionBase: collection.commissionBase,
    commission: collection.commission,
    net: collection.net,
    settlement: collection.settlement,
    stage: collection.stage,
    stageGroup: collection.stageGroup,
    dueBefore: collection.dueBefore,
    ruleId: collection.rule?.id ?? null,
    ruleVersion: collection.rule?.version ?? null,
    walletTransactionId: collection.walletTransactionId,
    creditedAt: collection.creditedAt,
    receiptMethod: collection.receipt?.method ?? null,
    receiptReference: collection.receipt?.reference ?? null,
    receiptDocumentId: collection.receiptDocumentId,
    proofFileId: collection.proofFileId,
    note: collection.note,
    recordedBy: collection.recordedBy,
    collectedAt: collection.collectedAt,
    createdAt: collection.createdAt,
  };
}

function paymentRequestOf(row: PaymentRequestRow): PaymentRequestRecord {
  return {
    id: row.id,
    caseId: row.caseId,
    debtorId: row.debtorId,
    amount: row.amount,
    status: row.status as PaymentRequestRecord['status'],
    paymentLinkId: row.paymentLinkId,
    paymentUrl: row.paymentUrl,
    requestedBy: row.requestedBy as PaymentRequestRecord['requestedBy'],
    installmentId: row.installmentId,
    settlementId: row.settlementId,
    idempotencyKey: row.debtorKey,
    expiresAt: row.expiresAt,
    paidAt: row.paidAt,
    createdAt: row.createdAt,
  };
}

function offlinePaymentOf(row: OfflinePaymentRow): OfflinePaymentRecord {
  return {
    id: row.id,
    caseId: row.caseId,
    source: row.method as OfflinePaymentSource,
    amount: row.amount,
    receivedAt: row.receivedAt,
    reference: row.externalRef,
    proofFileId: row.proofFileId,
    note: row.note,
    recordedBy: row.recordedBy,
    partnerId: row.partnerId,
    assignmentId: row.assignmentId,
    status: row.status as OfflinePaymentStatus,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
    rejectionReason: row.rejectionReason,
    collectionId: row.collectionId,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
  };
}

function offlinePaymentData(payment: OfflinePaymentRecord) {
  return {
    caseId: payment.caseId,
    method: payment.source,
    amount: payment.amount,
    externalRef: payment.reference,
    receivedAt: payment.receivedAt,
    recordedBy: payment.recordedBy,
    partnerId: payment.partnerId,
    assignmentId: payment.assignmentId,
    proofFileId: payment.proofFileId,
    note: payment.note,
    status: payment.status,
    reviewedBy: payment.reviewedBy,
    reviewedAt: payment.reviewedAt,
    rejectionReason: payment.rejectionReason,
    collectionId: payment.collectionId,
    idempotencyKey: payment.idempotencyKey,
    createdAt: payment.createdAt,
  };
}

function paymentRequestData(request: PaymentRequestRecord) {
  return {
    caseId: request.caseId,
    debtorId: request.debtorId,
    amount: request.amount,
    status: request.status,
    paymentLinkId: request.paymentLinkId,
    paymentUrl: request.paymentUrl,
    requestedBy: request.requestedBy,
    installmentId: request.installmentId,
    settlementId: request.settlementId,
    debtorKey: request.idempotencyKey,
    expiresAt: request.expiresAt,
    paidAt: request.paidAt,
    createdAt: request.createdAt,
  };
}

function documentRow(caseId: string, document: CaseDocumentData) {
  return {
    id: document.id,
    caseId,
    fileId: document.fileId,
    documentId: document.documentId,
    kind: document.kind,
    label: document.label,
    visibleToPartner: document.visibleToPartner,
    visibleToDebtor: document.visibleToDebtor,
    uploadedByType: document.addedBy.type,
    uploadedById: document.addedBy.id,
    createdAt: document.addedAt,
  };
}

/** Curseur d'une page : identifiant de la dernière ligne rendue (pagination par curseur de Prisma). */
function pageArgs(page: PageRequest) {
  return { take: page.limit + 1, ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}) };
}

function pageOf<T extends { id: string }>(
  rows: T[],
  page: PageRequest,
): { rows: T[]; nextCursor: string | null } {
  const more = rows.length > page.limit;
  const kept = more ? rows.slice(0, page.limit) : rows;
  return { rows: kept, nextCursor: more ? kept[kept.length - 1]!.id : null };
}

/**
 * Argent et espace du débiteur (lot R3) dans la base du service. Chaque écriture qui change le dossier
 * est conditionnée par sa version (verrou optimiste) et écrit dans la même transaction ses lignes
 * d'argent, ses pièces, son journal de preuve, son audit et ses événements (outbox). Les effets d'un
 * encaissement (crédit, reçu) et de la clôture sont conditionnés par l'état de leur ligne : rejoués,
 * ils n'écrivent rien.
 */
@Injectable()
export class PrismaMoneyStore implements MoneyStore {
  private readonly ids = new UuidV7Generator();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CASE_PERSONAL_DATA) private readonly personal: PersonalData,
  ) {}

  async money(caseId: string): Promise<CaseMoney> {
    const [row, sums, refunds] = await Promise.all([
      this.prisma.recoveryCase.findUnique({
        where: { id: caseId },
        select: {
          commissionedBase: true,
          commissionTotal: true,
          closedAt: true,
          closureNote: true,
          closedByType: true,
          closedById: true,
          certificateDocumentId: true,
          closureCompletedAt: true,
        },
      }),
      this.prisma.collection.aggregate({
        where: { caseId },
        _sum: { allocatedCosts: true, allocatedInterests: true, allocatedPrincipal: true, overpaid: true },
      }),
      this.prisma.overpaymentRefund.aggregate({ where: { caseId }, _sum: { amount: true } }),
    ]);
    return {
      totals: { base: row?.commissionedBase ?? 0, commission: row?.commissionTotal ?? 0 },
      collected: {
        costs: sums._sum.allocatedCosts ?? 0,
        interests: sums._sum.allocatedInterests ?? 0,
        principal: sums._sum.allocatedPrincipal ?? 0,
      },
      overpaid: sums._sum.overpaid ?? 0,
      refunded: refunds._sum.amount ?? 0,
      closure:
        row?.closedAt && row.closedByType
          ? {
              closedAt: row.closedAt,
              closedBy: { type: row.closedByType as EvidenceActorType, id: row.closedById },
              note: row.closureNote,
              certificateDocumentId: row.certificateDocumentId,
              completedAt: row.closureCompletedAt,
            }
          : null,
    };
  }

  async commit(
    record: RecoveryCaseRecord,
    writes: MoneyWrites,
    changes: CaseChanges,
    options: { inbox?: { eventId: string; consumer: string } } = {},
  ): Promise<SaveOutcome> {
    try {
      return await this.prisma.$transaction(async (tx): Promise<SaveOutcome> => {
        if (options.inbox && !(await this.markInbox(tx, options.inbox))) return 'duplicate';
        const updated = await tx.recoveryCase.updateMany({
          where: { id: record.id, version: record.version },
          data: {
            ...caseColumns(record),
            version: { increment: 1 },
            ...(writes.totals
              ? { commissionedBase: writes.totals.base, commissionTotal: writes.totals.commission }
              : {}),
            ...(writes.closure
              ? {
                  closedAt: writes.closure.closedAt,
                  closureNote: writes.closure.note,
                  closedByType: writes.closure.closedBy.type,
                  closedById: writes.closure.closedBy.id,
                  certificateDocumentId: writes.closure.certificateDocumentId,
                  closureCompletedAt: writes.closure.completedAt,
                }
              : {}),
          },
        });
        if (updated.count === 0) throw new StaleWrite();
        await insertDocuments(tx, record);
        await this.applyWrites(tx, writes);
        await writeChanges(tx, record.id, changes, () => this.ids.next());
        return 'saved';
      });
    } catch (error) {
      // Version changée, ou encaissement de même référence enregistré en même temps : l'appelant relit.
      if (error instanceof StaleWrite || isDuplicateCollection(error)) return 'stale';
      throw error;
    }
  }

  private async markInbox(tx: Tx, inbox: { eventId: string; consumer: string }): Promise<boolean> {
    const inserted = await tx.$executeRawUnsafe(
      'INSERT INTO processed_events (event_id, consumer, processed_at) VALUES ($1::uuid, $2, now()) ' +
        'ON CONFLICT DO NOTHING',
      inbox.eventId,
      inbox.consumer,
    );
    return inserted > 0;
  }

  private async applyWrites(tx: Tx, writes: MoneyWrites): Promise<void> {
    if (writes.collections?.length) {
      await tx.collection.createMany({ data: writes.collections.map(collectionData) });
    }
    for (const request of writes.paymentRequests ?? []) {
      const data = paymentRequestData(request);
      await tx.paymentRequest.upsert({
        where: { id: request.id },
        create: { id: request.id, ...data },
        update: data,
      });
    }
    for (const payment of writes.offlinePayments ?? []) {
      const data = offlinePaymentData(payment);
      await tx.offlinePayment.upsert({
        where: { id: payment.id },
        create: { id: payment.id, ...data },
        update: data,
      });
    }
    if (writes.refunds?.length) {
      await tx.overpaymentRefund.createMany({
        data: writes.refunds.map((refund) => ({
          id: refund.id,
          caseId: refund.caseId,
          amount: refund.amount,
          reference: refund.reference,
          note: refund.note,
          recordedBy: refund.recordedBy,
          idempotencyKey: refund.idempotencyKey,
          recordedAt: refund.recordedAt,
        })),
      });
    }
    for (const dispute of writes.disputes ?? []) {
      const data = {
        caseId: dispute.caseId,
        debtorId: dispute.debtorId,
        reason: dispute.reason,
        textEnc: dispute.text ? this.personal.encrypt(dispute.text, disputeTextContext(dispute.id)) : null,
        fileIds: dispute.fileIds,
        status: dispute.status,
        openedAt: dispute.openedAt,
        creditorAnswerDue: dispute.creditorAnswerDueAt,
        creditorAnswerAt: dispute.creditorAnsweredAt,
        resolution: dispute.resolution,
        resolutionNote: dispute.resolutionNote,
        resolvedBy: dispute.resolvedBy,
        resolvedAt: dispute.resolvedAt,
        idempotencyKey: dispute.idempotencyKey,
      };
      await tx.dispute.upsert({
        where: { id: dispute.id },
        create: { id: dispute.id, ...data },
        update: data,
      });
    }
    if (writes.callbacks?.length) {
      await tx.callbackRequest.createMany({
        data: writes.callbacks.map((callback) => ({
          id: callback.id,
          caseId: callback.caseId,
          debtorId: callback.debtorId,
          slotStart: callback.slotStart,
          slotEnd: callback.slotEnd,
          status: callback.status,
          noteEnc: callback.message
            ? this.personal.encrypt(callback.message, callbackNoteContext(callback.id))
            : null,
          createdAt: callback.createdAt,
        })),
      });
    }
  }

  async markProcessed(inbox: { eventId: string; consumer: string }): Promise<void> {
    await this.prisma.$transaction((tx) => this.markInbox(tx, inbox));
  }

  async collection(id: string): Promise<CollectionRecord | null> {
    const row = await this.prisma.collection.findUnique({ where: { id } });
    return row ? collectionOf(row) : null;
  }

  async collectionByReference(reference: string): Promise<CollectionRecord | null> {
    const row = await this.prisma.collection.findUnique({ where: { reference } });
    return row ? collectionOf(row) : null;
  }

  async collections(caseId: string): Promise<CollectionRecord[]> {
    const rows = await this.prisma.collection.findMany({
      where: { caseId },
      orderBy: [{ collectedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(collectionOf);
  }

  async markCredited(
    collectionId: string,
    walletTransactionId: string,
    at: Date,
    changes: CaseChanges,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.collection.findUnique({ where: { id: collectionId }, select: { caseId: true } });
      if (!row) return false;
      const updated = await tx.collection.updateMany({
        where: { id: collectionId, creditedAt: null },
        data: { walletTransactionId, creditedAt: at },
      });
      if (updated.count === 0) return false;
      await writeChanges(tx, row.caseId, changes, () => this.ids.next());
      return true;
    });
  }

  async attachReceipt(
    collectionId: string,
    document: CaseDocumentData,
    changes: CaseChanges,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.collection.findUnique({ where: { id: collectionId }, select: { caseId: true } });
      if (!row) return false;
      const updated = await tx.collection.updateMany({
        where: { id: collectionId, receiptDocumentId: null },
        data: { receiptDocumentId: document.documentId },
      });
      if (updated.count === 0) return false;
      await tx.caseDocument.createMany({ data: [documentRow(row.caseId, document)], skipDuplicates: true });
      await writeChanges(tx, row.caseId, changes, () => this.ids.next());
      return true;
    });
  }

  async pendingSettlements(limit: number): Promise<CollectionRecord[]> {
    const pending = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM collections
      WHERE (commission_settlement = 'deducted' AND credited_at IS NULL AND gross > overpaid)
         OR (receipt_method IS NOT NULL AND receipt_document_id IS NULL)
      ORDER BY created_at ASC
      LIMIT ${limit}`;
    if (pending.length === 0) return [];
    const rows = await this.prisma.collection.findMany({
      where: { id: { in: pending.map((row) => row.id) } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(collectionOf);
  }

  async completeClosure(
    caseId: string,
    input: { at: Date; certificate: CaseDocumentData | null; revokedRequestIds: readonly string[] },
    changes: CaseChanges,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.recoveryCase.updateMany({
        where: { id: caseId, status: 'closed', closedAt: { not: null }, closureCompletedAt: null },
        data: {
          closureCompletedAt: input.at,
          certificateDocumentId: input.certificate?.documentId ?? null,
        },
      });
      if (updated.count === 0) return false;
      if (input.certificate) {
        await tx.caseDocument.createMany({
          data: [documentRow(caseId, input.certificate)],
          skipDuplicates: true,
        });
      }
      if (input.revokedRequestIds.length > 0) {
        await tx.paymentRequest.updateMany({
          where: { id: { in: [...input.revokedRequestIds] }, status: 'active' },
          data: { status: 'revoked' },
        });
      }
      await writeChanges(tx, caseId, changes, () => this.ids.next());
      return true;
    });
  }

  async pendingClosures(limit: number): Promise<string[]> {
    const rows = await this.prisma.recoveryCase.findMany({
      where: { status: 'closed', closedAt: { not: null }, closureCompletedAt: null },
      select: { id: true },
      orderBy: { closedAt: 'asc' },
      take: limit,
    });
    return rows.map((row) => row.id);
  }

  async paymentRequest(id: string): Promise<PaymentRequestRecord | null> {
    const row = await this.prisma.paymentRequest.findUnique({ where: { id } });
    return row ? paymentRequestOf(row) : null;
  }

  async paymentRequestByKey(caseId: string, key: string): Promise<PaymentRequestRecord | null> {
    const row = await this.prisma.paymentRequest.findUnique({
      where: { caseId_debtorKey: { caseId, debtorKey: key } },
    });
    return row ? paymentRequestOf(row) : null;
  }

  async activePaymentRequests(caseId: string): Promise<PaymentRequestRecord[]> {
    const rows = await this.prisma.paymentRequest.findMany({
      where: { caseId, status: 'active' },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(paymentRequestOf);
  }

  async offlinePayment(id: string): Promise<OfflinePaymentRecord | null> {
    const row = await this.prisma.offlinePayment.findUnique({ where: { id } });
    return row ? offlinePaymentOf(row) : null;
  }

  async offlinePaymentByKey(recordedBy: string, key: string): Promise<OfflinePaymentRecord | null> {
    const row = await this.prisma.offlinePayment.findUnique({
      where: { recordedBy_idempotencyKey: { recordedBy, idempotencyKey: key } },
    });
    return row ? offlinePaymentOf(row) : null;
  }

  async listOfflinePayments(
    filter: OfflinePaymentFilter,
    page: PageRequest,
  ): Promise<{ items: (OfflinePaymentRecord & { caseNumber: string })[]; nextCursor: string | null }> {
    const rows = await this.prisma.offlinePayment.findMany({
      where: {
        status: { in: [...filter.statuses] },
        ...(filter.caseId ? { caseId: filter.caseId } : {}),
        ...(filter.assignedAgentId ? { case: { assignedAgentId: filter.assignedAgentId } } : {}),
      },
      include: { case: { select: { number: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      ...pageArgs(page),
    });
    const kept = pageOf(rows, page);
    return {
      items: kept.rows.map((row) => ({ ...offlinePaymentOf(row), caseNumber: row.case.number })),
      nextCursor: kept.nextCursor,
    };
  }

  async refundByKey(recordedBy: string, key: string): Promise<OverpaymentRefundRecord | null> {
    const row = await this.prisma.overpaymentRefund.findUnique({
      where: { recordedBy_idempotencyKey: { recordedBy, idempotencyKey: key } },
    });
    return row
      ? {
          id: row.id,
          caseId: row.caseId,
          amount: row.amount,
          reference: row.reference,
          note: row.note,
          recordedBy: row.recordedBy,
          idempotencyKey: row.idempotencyKey,
          recordedAt: row.recordedAt,
        }
      : null;
  }

  private disputeOf(row: DisputeRow): DisputeRecord {
    return {
      id: row.id,
      caseId: row.caseId,
      debtorId: row.debtorId,
      reason: row.reason as DisputeReason,
      text: row.textEnc ? this.personal.decrypt(row.textEnc, disputeTextContext(row.id)) : null,
      fileIds: row.fileIds,
      status: row.status as DisputeStatus,
      openedAt: row.openedAt,
      creditorAnswerDueAt: row.creditorAnswerDue,
      creditorAnsweredAt: row.creditorAnswerAt,
      resolution: (row.resolution as DisputeResolution | null) ?? null,
      resolutionNote: row.resolutionNote,
      resolvedBy: row.resolvedBy,
      resolvedAt: row.resolvedAt,
      idempotencyKey: row.idempotencyKey,
    };
  }

  async disputes(caseId: string): Promise<DisputeRecord[]> {
    const rows = await this.prisma.dispute.findMany({
      where: { caseId },
      orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => this.disputeOf(row));
  }

  async disputeByKey(caseId: string, key: string): Promise<DisputeRecord | null> {
    const row = await this.prisma.dispute.findUnique({
      where: { caseId_idempotencyKey: { caseId, idempotencyKey: key } },
    });
    return row ? this.disputeOf(row) : null;
  }

  async pendingCallbacks(caseId: string): Promise<CallbackRecord[]> {
    const rows: CallbackRow[] = await this.prisma.callbackRequest.findMany({
      where: { caseId, status: 'pending' },
      orderBy: { slotStart: 'asc' },
    });
    return rows.map((row) => ({
      id: row.id,
      caseId: row.caseId,
      debtorId: row.debtorId ?? '',
      slotStart: row.slotStart,
      slotEnd: row.slotEnd,
      message: row.noteEnc ? this.personal.decrypt(row.noteEnc, callbackNoteContext(row.id)) : null,
      status: row.status as CallbackRecord['status'],
      createdAt: row.createdAt,
    }));
  }

  async remittances(
    creditor: Holder,
    filter: RemittanceFilter,
    page: PageRequest,
  ): Promise<{ items: RemittanceRecord[]; nextCursor: string | null }> {
    const creditedAt: Prisma.DateTimeNullableFilter = { not: null };
    if (filter.from) creditedAt.gte = filter.from;
    if (filter.to) creditedAt.lte = filter.to;
    const rows = await this.prisma.collection.findMany({
      where: {
        creditedAt,
        case: { creditorType: creditor.type, creditorId: creditor.id },
        ...(filter.caseId ? { caseId: filter.caseId } : {}),
      },
      include: { case: { select: { number: true } } },
      orderBy: [{ creditedAt: 'desc' }, { id: 'desc' }],
      ...pageArgs(page),
    });
    const kept = pageOf(rows, page);
    return {
      items: kept.rows.map((row) => ({ collection: collectionOf(row), caseNumber: row.case.number })),
      nextCursor: kept.nextCursor,
    };
  }
}
