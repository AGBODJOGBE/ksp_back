import { type SqlExecutor, SqlInboxStore, type TransactionalSqlClient } from '@ksp/platform';
import { Injectable } from '@nestjs/common';
import { type StoredFile as FileRow } from '../../../prisma/generated';
import { type AccountErasure, type Completion, type FileRepository } from '../../application/ports';
import { type Purpose } from '../../domain/purposes';
import { type DeletionReason, type FileSubject, type StoredFile } from '../../domain/stored-file';
import { PrismaService } from '../prisma/prisma.service';

function toDomain(row: FileRow): StoredFile {
  return {
    id: row.id,
    purpose: row.purpose as StoredFile['purpose'],
    fileName: row.fileName,
    contentType: row.contentType as StoredFile['contentType'],
    sizeBytes: row.sizeBytes,
    storageKey: row.storageKey,
    status: row.status as StoredFile['status'],
    rejectionReason: row.rejectionReason as StoredFile['rejectionReason'],
    ownerId: row.ownerId,
    subject: row.subjectType && row.subjectId ? { type: row.subjectType, id: row.subjectId } : null,
    attachedBy: row.attachedBy,
    attachedAt: row.attachedAt,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    deletedAt: row.deletedAt,
    deletionReason: row.deletionReason as DeletionReason | null,
    eraseAfter: row.eraseAfter,
  };
}

/** Extension d'un nom neutre, comme neutralFileName du domaine. */
const NEUTRAL_NAME_SQL =
  "id::text || '.' || CASE content_type WHEN 'application/pdf' THEN 'pdf' WHEN 'image/jpeg' THEN 'jpg' " +
  "WHEN 'image/png' THEN 'png' WHEN 'image/webp' THEN 'webp' ELSE 'bin' END";

/**
 * Dépôt des fichiers. Chaque changement d'état est conditionnel (état attendu dans la clause WHERE) :
 * plusieurs instances du service, ou deux requêtes simultanées, ne l'appliquent qu'une fois. Les
 * lots de la purge sont pris avec FOR UPDATE SKIP LOCKED.
 */
@Injectable()
export class PrismaFileRepository implements FileRepository {
  private readonly inbox: SqlInboxStore;

  constructor(private readonly prisma: PrismaService) {
    this.inbox = new SqlInboxStore(prisma as unknown as TransactionalSqlClient);
  }

  async create(file: StoredFile): Promise<void> {
    await this.prisma.storedFile.create({
      data: {
        id: file.id,
        purpose: file.purpose,
        fileName: file.fileName,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        storageKey: file.storageKey,
        status: file.status,
        rejectionReason: file.rejectionReason,
        ownerId: file.ownerId,
        subjectType: file.subject?.type ?? null,
        subjectId: file.subject?.id ?? null,
        attachedBy: file.attachedBy,
        attachedAt: file.attachedAt,
        createdAt: file.createdAt,
        completedAt: file.completedAt,
        deletedAt: file.deletedAt,
        deletionReason: file.deletionReason,
        eraseAfter: file.eraseAfter,
      },
    });
  }

  async findById(id: string): Promise<StoredFile | null> {
    const row = await this.prisma.storedFile.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async complete(id: string, completion: Completion): Promise<boolean> {
    const { count } = await this.prisma.storedFile.updateMany({
      where: { id, status: 'pending' },
      data:
        completion.status === 'available'
          ? { status: 'available', completedAt: completion.completedAt }
          : {
              status: 'rejected',
              rejectionReason: completion.reason,
              completedAt: completion.completedAt,
              eraseAfter: completion.eraseAfter,
            },
    });
    return count === 1;
  }

  async attach(
    id: string,
    input: { subject: FileSubject; attachedBy: string; attachedAt: Date },
  ): Promise<boolean> {
    const { count } = await this.prisma.storedFile.updateMany({
      where: { id, status: 'available', subjectId: null },
      data: {
        subjectType: input.subject.type,
        subjectId: input.subject.id,
        attachedBy: input.attachedBy,
        attachedAt: input.attachedAt,
      },
    });
    return count === 1;
  }

  async softDelete(
    id: string,
    input: { reason: DeletionReason; deletedAt: Date; eraseAfter: Date },
  ): Promise<boolean> {
    const { count } = await this.prisma.storedFile.updateMany({
      where: { id, status: { not: 'deleted' } },
      data: {
        status: 'deleted',
        deletionReason: input.reason,
        deletedAt: input.deletedAt,
        eraseAfter: input.eraseAfter,
      },
    });
    return count === 1;
  }

  async listBySubject(
    subject: FileSubject,
    purposes: readonly Purpose[],
    limit: number,
  ): Promise<StoredFile[]> {
    const rows = await this.prisma.storedFile.findMany({
      where: {
        subjectType: subject.type,
        subjectId: subject.id,
        status: 'available',
        purpose: { in: [...purposes] },
      },
      orderBy: { id: 'asc' },
      take: limit,
    });
    return rows.map(toDomain);
  }

  countPending(ownerId: string): Promise<number> {
    return this.prisma.storedFile.count({ where: { ownerId, status: 'pending' } });
  }

  async declaredBytesSince(ownerId: string, since: Date): Promise<number> {
    const result = await this.prisma.storedFile.aggregate({
      where: { ownerId, createdAt: { gte: since } },
      _sum: { sizeBytes: true },
    });
    return Number(result._sum.sizeBytes ?? 0);
  }

  expirePending(input: { createdBefore: Date; now: Date; limit: number }): Promise<number> {
    return this.prisma.$executeRawUnsafe(
      "UPDATE files SET status = 'deleted', deletion_reason = 'upload_expired', deleted_at = $2::timestamptz, " +
        'erase_after = $2::timestamptz WHERE id IN (SELECT id FROM files WHERE status = $3 ' +
        'AND created_at < $1::timestamptz ORDER BY created_at LIMIT $4::int FOR UPDATE SKIP LOCKED)',
      input.createdBefore.toISOString(),
      input.now.toISOString(),
      'pending',
      input.limit,
    );
  }

  expireUnattached(input: { completedBefore: Date; now: Date; limit: number }): Promise<number> {
    return this.prisma.$executeRawUnsafe(
      "UPDATE files SET status = 'deleted', deletion_reason = 'never_attached', deleted_at = $2::timestamptz, " +
        "erase_after = $2::timestamptz WHERE id IN (SELECT id FROM files WHERE status = 'available' " +
        'AND subject_id IS NULL AND completed_at < $1::timestamptz ORDER BY completed_at LIMIT $3::int ' +
        'FOR UPDATE SKIP LOCKED)',
      input.completedBefore.toISOString(),
      input.now.toISOString(),
      input.limit,
    );
  }

  async listToErase(now: Date, limit: number): Promise<StoredFile[]> {
    const rows = await this.prisma.storedFile.findMany({
      where: { eraseAfter: { lte: now }, status: { in: ['deleted', 'rejected'] } },
      orderBy: { eraseAfter: 'asc' },
      take: limit,
    });
    return rows.map(toDomain);
  }

  async remove(id: string, now: Date): Promise<void> {
    await this.prisma.storedFile.deleteMany({
      where: { id, eraseAfter: { lte: now }, status: { in: ['deleted', 'rejected'] } },
    });
  }

  async eraseAccount(
    userId: string,
    input: { eventId: string; consumer: string; erasedPurposes: readonly Purpose[]; now: Date },
  ): Promise<AccountErasure> {
    let erased = 0;
    let detached = 0;
    const purposes = [...input.erasedPurposes];
    const status = await this.inbox.runOnce(input.eventId, input.consumer, async (tx: SqlExecutor) => {
      // Envois en attente, fichiers jamais rattachés, finalités effacées avec le compte : supprimés,
      // effacement physique au prochain passage de la purge.
      erased = await tx.$executeRawUnsafe(
        "UPDATE files SET status = 'deleted', deletion_reason = 'account_deleted', deleted_at = $2::timestamptz, " +
          "erase_after = $2::timestamptz WHERE owner_id = $1::uuid AND status <> 'deleted' " +
          "AND (status = 'pending' OR subject_id IS NULL OR purpose = ANY($3::text[]))",
        userId,
        input.now.toISOString(),
        purposes,
      );
      // Déjà supprimés mais encore dans leur délai de grâce : effacement avancé pour ces finalités.
      await tx.$executeRawUnsafe(
        'UPDATE files SET erase_after = $2::timestamptz WHERE owner_id = $1::uuid ' +
          "AND status = 'deleted' AND purpose = ANY($3::text[]) AND erase_after > $2::timestamptz",
        userId,
        input.now.toISOString(),
        purposes,
      );
      const kept = await tx.$queryRawUnsafe<{ count: bigint | number }[]>(
        "SELECT count(*) AS count FROM files WHERE owner_id = $1::uuid AND status <> 'deleted'",
        userId,
      );
      detached = Number(kept[0]?.count ?? 0);
      // Plus aucun lien avec le compte : propriétaire retiré, nom d'origine (souvent nominatif)
      // remplacé par un nom neutre.
      await tx.$executeRawUnsafe(
        `UPDATE files SET owner_id = NULL, file_name = ${NEUTRAL_NAME_SQL} WHERE owner_id = $1::uuid`,
        userId,
      );
    });
    return status === 'duplicate' ? { status, erased: 0, detached: 0 } : { status, erased, detached };
  }
}
