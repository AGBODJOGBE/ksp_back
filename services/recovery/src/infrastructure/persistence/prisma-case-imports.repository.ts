import { Inject, Injectable } from '@nestjs/common';
import { type CaseImport as ImportRow, type CaseImportLine as LineRow } from '../../../prisma/generated';
import {
  type CaseChanges,
  type CaseImportRecord,
  type CaseImportRepository,
  type ImportLineRecord,
  type RecoveryCaseRecord,
} from '../../application/cases/ports';
import { type Holder, type PersonalData } from '../../application/ports';
import { type ImportLineError, type ImportLineStatus, type ImportLineValues } from '../../domain/import';
import { PrismaService } from '../prisma/prisma.service';
import { UuidV7Generator } from '../system/system';
import { CASE_PERSONAL_DATA, insertCase } from './prisma-cases.repository';
import { isUniqueViolation, json, type Tx } from './prisma-case-rows';

/** Valeurs d'une ligne : coordonnées de débiteurs, chiffrées et liées à l'import et à la ligne. */
const valuesContext = (importId: string, row: number) => `case_import_lines.values:${importId}:${row}`;

class StaleImport extends Error {}

/**
 * Imports de dossiers (R-SD-01, R-SD-02) : lignes lues chiffrées, compteurs, verrou optimiste. La
 * confirmation crée les brouillons (même écriture que CreateCase) et rattache les lignes dans une
 * seule transaction.
 */
@Injectable()
export class PrismaCaseImportRepository implements CaseImportRepository {
  private readonly ids = new UuidV7Generator();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CASE_PERSONAL_DATA) private readonly personal: PersonalData,
  ) {}

  private toRecord(row: ImportRow & { lines: LineRow[] }): CaseImportRecord {
    return {
      id: row.id,
      creditor: { type: row.creditorType, id: row.creditorId },
      createdBy: row.createdBy,
      kind: row.kind as CaseImportRecord['kind'],
      fileId: row.fileId ?? '',
      evidenceArchiveFileId: row.evidenceArchiveFileId,
      status: row.status as CaseImportRecord['status'],
      idempotencyKey: row.idempotencyKey,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      version: row.version,
      lines: row.lines.map((line): ImportLineRecord => ({
        row: line.rowNumber,
        values: JSON.parse(
          this.personal.decrypt(line.valuesEnc, valuesContext(row.id, line.rowNumber)),
        ) as ImportLineValues,
        status: line.status as ImportLineStatus,
        errors: (line.errors ?? []) as unknown as ImportLineError[],
        caseId: line.caseId,
      })),
    };
  }

  private counts(record: CaseImportRecord) {
    return {
      linesTotal: record.lines.length,
      linesValid: record.lines.filter((line) => line.status === 'valid').length,
      linesInvalid: record.lines.filter((line) => line.status === 'invalid').length,
    };
  }

  private async writeLines(tx: Tx, record: CaseImportRecord) {
    await tx.caseImportLine.deleteMany({ where: { importId: record.id } });
    if (record.lines.length === 0) return;
    await tx.caseImportLine.createMany({
      data: record.lines.map((line) => ({
        id: this.ids.next(),
        importId: record.id,
        rowNumber: line.row,
        valuesEnc: this.personal.encrypt(JSON.stringify(line.values), valuesContext(record.id, line.row)),
        status: line.status,
        errors: json(line.errors),
        caseId: line.caseId,
      })),
    });
  }

  async find(id: string): Promise<CaseImportRecord | null> {
    const row = await this.prisma.caseImport.findUnique({
      where: { id },
      include: { lines: { orderBy: { rowNumber: 'asc' } } },
    });
    return row ? this.toRecord(row) : null;
  }

  async findByIdempotencyKey(creditor: Holder, key: string): Promise<CaseImportRecord | null> {
    const row = await this.prisma.caseImport.findUnique({
      where: {
        creditorType_creditorId_idempotencyKey: {
          creditorType: creditor.type,
          creditorId: creditor.id,
          idempotencyKey: key,
        },
      },
      include: { lines: { orderBy: { rowNumber: 'asc' } } },
    });
    return row ? this.toRecord(row) : null;
  }

  async create(record: CaseImportRecord): Promise<'created' | 'duplicate'> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.caseImport.create({
          data: {
            id: record.id,
            creditorType: record.creditor.type,
            creditorId: record.creditor.id,
            createdBy: record.createdBy,
            fileId: record.fileId,
            evidenceArchiveFileId: record.evidenceArchiveFileId,
            kind: record.kind,
            status: record.status,
            idempotencyKey: record.idempotencyKey,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            ...this.counts(record),
          },
        });
        await this.writeLines(tx, record);
      });
      return 'created';
    } catch (error) {
      if (isUniqueViolation(error)) return 'duplicate';
      throw error;
    }
  }

  private async bump(tx: Tx, record: CaseImportRecord) {
    const updated = await tx.caseImport.updateMany({
      where: { id: record.id, version: record.version },
      data: {
        status: record.status,
        updatedAt: record.updatedAt,
        ...this.counts(record),
        version: { increment: 1 },
      },
    });
    if (updated.count === 0) throw new StaleImport();
  }

  async saveLines(record: CaseImportRecord): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.bump(tx, record);
        await this.writeLines(tx, record);
      });
      return true;
    } catch (error) {
      if (error instanceof StaleImport) return false;
      throw error;
    }
  }

  async confirm(
    record: CaseImportRecord,
    cases: readonly { record: RecoveryCaseRecord; changes: CaseChanges }[],
  ): Promise<RecoveryCaseRecord[] | 'stale'> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await this.bump(tx, record);
          const created: RecoveryCaseRecord[] = [];
          for (const draft of cases) {
            created.push(
              await insertCase(tx, draft.record, draft.changes, this.personal, () => this.ids.next()),
            );
          }
          await this.writeLines(tx, record);
          return created;
        },
        { timeout: 60_000 },
      );
    } catch (error) {
      if (error instanceof StaleImport) return 'stale';
      throw error;
    }
  }
}
