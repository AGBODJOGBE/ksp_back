import { Inject, Injectable } from '@nestjs/common';
import { type Prisma } from '../../../prisma/generated';
import {
  type CaseAuditEntry,
  type CaseChanges,
  type CaseRepository,
  type CaseSummaryRecord,
  type RecoveryCaseRecord,
  type SaveOutcome,
  type SimilarCaseProbe,
} from '../../application/cases/ports';
import { type Holder, type PersonalData } from '../../application/ports';
import { PrismaService } from '../prisma/prisma.service';
import { UuidV7Generator } from '../system/system';
import {
  CASE_INCLUDE,
  caseColumns,
  caseNumber,
  caseOf,
  insertContent,
  insertDocuments,
  isUniqueViolation,
  json,
  replaceContent,
  SUMMARY_INCLUDE,
  summaryOfRow,
  type Tx,
  writeChanges,
} from './prisma-case-rows';

/** Dossiers ouverts (doublons R-SD-06) : tout sauf refusé et clos. */
const OPEN_STATUSES = [
  'draft',
  'awaiting_fee',
  'under_review',
  'info_requested',
  'active',
  'suspended',
] as const;
const UNPAID_STATUSES = ['draft', 'awaiting_fee'] as const;

/** Version lue périmée : annule la transaction en cours. */
class StaleCase extends Error {}

/** Jeton du chiffrement des coordonnées : injecté par la racine de composition. */
export const CASE_PERSONAL_DATA = Symbol('CASE_PERSONAL_DATA');

/**
 * Nouveau dossier dans une transaction : numéro tiré de la séquence (RC-000123), parties chiffrées,
 * pièces et changements. Partagé avec la confirmation d'un import.
 */
export async function insertCase(
  tx: Tx,
  record: RecoveryCaseRecord,
  changes: CaseChanges,
  personal: PersonalData,
  nextId: () => string,
): Promise<RecoveryCaseRecord> {
  const [row] = await tx.$queryRaw<{ value: number }[]>`
    SELECT nextval(pg_get_serial_sequence('recovery_cases', 'sequence'))::int AS value`;
  const sequence = Number(row!.value);
  const stored: RecoveryCaseRecord = { ...record, number: caseNumber(sequence), version: 0 };
  await tx.recoveryCase.create({
    data: { id: stored.id, sequence, ...caseColumns(stored), createdAt: stored.createdAt },
  });
  await insertContent(tx, stored, personal);
  await insertDocuments(tx, stored);
  await writeChanges(tx, stored.id, changes, nextId);
  return stored;
}

/**
 * Dépôt des dossiers (agrégat : dossier, débiteurs et contacts chiffrés, créances, démarches, pièces).
 * Chaque enregistrement est conditionné par la version lue (verrou optimiste) et écrit, dans la même
 * transaction, le journal de preuve, les passages d'étape, l'audit et les événements de l'outbox.
 */
@Injectable()
export class PrismaCaseRepository implements CaseRepository {
  private readonly ids = new UuidV7Generator();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CASE_PERSONAL_DATA) private readonly personal: PersonalData,
  ) {}

  async find(id: string): Promise<RecoveryCaseRecord | null> {
    const row = await this.prisma.recoveryCase.findUnique({ where: { id }, include: CASE_INCLUDE });
    return row ? caseOf(row, this.personal) : null;
  }

  async findByIdempotencyKey(creditor: Holder, key: string): Promise<RecoveryCaseRecord | null> {
    const row = await this.prisma.recoveryCase.findUnique({
      where: {
        creditorType_creditorId_idempotencyKey: {
          creditorType: creditor.type,
          creditorId: creditor.id,
          idempotencyKey: key,
        },
      },
      include: CASE_INCLUDE,
    });
    return row ? caseOf(row, this.personal) : null;
  }

  async create(record: RecoveryCaseRecord, changes: CaseChanges): Promise<RecoveryCaseRecord | 'duplicate'> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Rejeu ordinaire : aucun numéro consommé. Deux envois simultanés : la contrainte tranche (un
        // numéro peut alors manquer dans la séquence).
        const existing = await tx.recoveryCase.findFirst({
          where: {
            OR: [
              { id: record.id },
              ...(record.idempotencyKey
                ? [
                    {
                      creditorType: record.creditor.type,
                      creditorId: record.creditor.id,
                      idempotencyKey: record.idempotencyKey,
                    },
                  ]
                : []),
            ],
          },
          select: { id: true },
        });
        if (existing) return 'duplicate' as const;
        return insertCase(tx, record, changes, this.personal, () => this.ids.next());
      });
    } catch (error) {
      if (isUniqueViolation(error)) return 'duplicate';
      throw error;
    }
  }

  async save(
    record: RecoveryCaseRecord,
    changes: CaseChanges,
    options: { content?: boolean; inbox?: { eventId: string; consumer: string } } = {},
  ): Promise<SaveOutcome> {
    try {
      return await this.prisma.$transaction(async (tx): Promise<SaveOutcome> => {
        if (options.inbox) {
          const inserted = await tx.$executeRawUnsafe(
            'INSERT INTO processed_events (event_id, consumer, processed_at) VALUES ($1::uuid, $2, now()) ' +
              'ON CONFLICT DO NOTHING',
            options.inbox.eventId,
            options.inbox.consumer,
          );
          if (inserted === 0) return 'duplicate';
        }
        const updated = await tx.recoveryCase.updateMany({
          where: { id: record.id, version: record.version },
          data: { ...caseColumns(record), version: { increment: 1 } },
        });
        // Version changée : la marque de l'inbox est annulée avec le reste (message retraité).
        if (updated.count === 0) throw new StaleCase();
        if (options.content) await replaceContent(tx, record, this.personal);
        await insertDocuments(tx, record);
        await writeChanges(tx, record.id, changes, () => this.ids.next());
        return 'saved';
      });
    } catch (error) {
      if (error instanceof StaleCase) return 'stale';
      throw error;
    }
  }

  async deleteUnpaid(record: RecoveryCaseRecord, audit: CaseAuditEntry): Promise<boolean> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Brouillon jamais envoyé (R-SD-04) : son journal part avec lui, seule exception à l'ajout
        // seul avec la purge des dossiers clos (déclencheur evidence_append_only).
        await tx.$executeRawUnsafe(`SET LOCAL recovery.evidence_purge = 'on'`);
        await tx.evidenceEntry.deleteMany({ where: { caseId: record.id } });
        const deleted = await tx.recoveryCase.deleteMany({
          where: {
            id: record.id,
            version: record.version,
            status: { in: [...UNPAID_STATUSES] },
            caseFeePaidAt: null,
          },
        });
        if (deleted.count === 0) throw new StaleCase();
        await tx.auditEntry.create({
          data: {
            id: this.ids.next(),
            actorId: audit.actorId,
            action: audit.action,
            entityType: audit.entityType,
            entityId: audit.entityId,
            at: audit.at,
            ...(audit.details ? { details: json(audit.details) } : {}),
          },
        });
        return true;
      });
    } catch (error) {
      if (error instanceof StaleCase) return false;
      throw error;
    }
  }

  async findSimilarOpen(
    creditor: Holder,
    probe: SimilarCaseProbe,
    excludeCaseId: string | null,
  ): Promise<CaseSummaryRecord[]> {
    const indexes = [
      ...probe.phones.map((phone) => this.personal.phoneIndex(phone)),
      ...probe.emails.map((email) => this.personal.emailIndex(email)),
    ];
    if (indexes.length === 0 || probe.references.length === 0) return [];
    const rows = await this.prisma.recoveryCase.findMany({
      where: {
        creditorType: creditor.type,
        creditorId: creditor.id,
        status: { in: [...OPEN_STATUSES] },
        ...(excludeCaseId ? { id: { not: excludeCaseId } } : {}),
        debtors: { some: { contacts: { some: { valueIndex: { in: indexes } } } } },
        claims: { some: { reference: { in: [...probe.references] } } },
      },
      include: SUMMARY_INCLUDE,
      orderBy: { sequence: 'desc' },
      take: 20,
    });
    return rows.map((row) => summaryOfRow(row, this.personal));
  }

  private async listWhere(
    where: Prisma.RecoveryCaseWhereInput,
    limit: number,
    orderBy: Prisma.RecoveryCaseOrderByWithRelationInput,
  ) {
    const rows = await this.prisma.recoveryCase.findMany({
      where,
      include: CASE_INCLUDE,
      orderBy,
      take: limit,
    });
    return rows.map((row) => caseOf(row, this.personal));
  }

  listUnpaidCreatedBefore(before: Date, limit: number): Promise<RecoveryCaseRecord[]> {
    return this.listWhere(
      { status: { in: [...UNPAID_STATUSES] }, caseFeePaidAt: null, createdAt: { lte: before } },
      limit,
      { createdAt: 'asc' },
    );
  }

  listInfoRequestedBefore(before: Date, limit: number): Promise<RecoveryCaseRecord[]> {
    return this.listWhere({ status: 'info_requested', infoRequestedAt: { lte: before } }, limit, {
      infoRequestedAt: 'asc',
    });
  }

  listPendingFeeSettlements(limit: number): Promise<RecoveryCaseRecord[]> {
    return this.listWhere(
      {
        status: 'rejected',
        OR: [
          { caseFeeDebitReference: { not: null }, feeRefundedAt: null },
          { feeRefundedAt: { not: null }, studyFee: { gt: 0 }, studyFeeChargedAt: null },
        ],
      },
      limit,
      { updatedAt: 'asc' },
    );
  }
}
