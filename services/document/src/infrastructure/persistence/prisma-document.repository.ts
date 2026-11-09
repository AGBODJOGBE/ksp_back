import {
  appendToOutbox,
  createEnvelope,
  type SqlExecutor,
  SqlInboxStore,
  type TransactionalSqlClient,
} from '@ksp/platform';
import { Injectable } from '@nestjs/common';
import {
  type Document as DocumentRow,
  Prisma,
  type SignatureCode as CodeRow,
  type SignatureRequest as RequestRow,
} from '../../../prisma/generated';
import {
  type AccountErasure,
  type DocumentRepository,
  type SignatureCompletion,
} from '../../application/ports';
import { type DocumentRecord, type DocumentStatus } from '../../domain/document';
import {
  type CodeChannel,
  type SignatureCode,
  type SignatureRequestRecord,
  type SignatureStatus,
} from '../../domain/signature';
import { PrismaService } from '../prisma/prisma.service';

function toDocument(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    template: row.template,
    templateVersion: row.templateVersion,
    title: row.title,
    number: row.number,
    status: row.status as DocumentStatus,
    subject: { type: row.subjectType, id: row.subjectId },
    ownerId: row.ownerId,
    producerService: row.producerService,
    idempotencyKey: row.idempotencyKey,
    fileId: row.fileId,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes,
    signedFileId: row.signedFileId,
    signedSha256: row.signedSha256,
    createdAt: row.createdAt,
    signedAt: row.signedAt,
    cancelledAt: row.cancelledAt,
    cancellationReason: row.cancellationReason,
  };
}

function toRequest(row: RequestRow): SignatureRequestRecord {
  return {
    id: row.id,
    documentId: row.documentId,
    status: row.status as SignatureStatus,
    signerUserId: row.signerUserId,
    signerPhoneE164: row.signerPhoneE164,
    signerEmail: row.signerEmail,
    signerPhoneMasked: row.signerPhoneMasked,
    signerName: row.signerName,
    tokenHash: row.tokenHash,
    documentSha256: row.documentSha256,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    signedAt: row.signedAt,
    closedAt: row.closedAt,
  };
}

function toCode(row: CodeRow): SignatureCode {
  return {
    id: row.id,
    requestId: row.requestId,
    codeHash: row.codeHash,
    channel: row.channel as CodeChannel,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    attempts: row.attempts,
    consumedAt: row.consumedAt,
  };
}

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/** Coordonnées en clair effacées à la clôture d'une demande (données personnelles). */
const CLOSE = { signerPhoneE164: null, signerEmail: null } as const;

/**
 * Dépôt du service document. Chaque changement d'état est conditionnel (état attendu dans la
 * clause WHERE) : deux requêtes simultanées ou plusieurs instances ne l'appliquent qu'une fois.
 */
@Injectable()
export class PrismaDocumentRepository implements DocumentRepository {
  private readonly inbox: SqlInboxStore;

  constructor(private readonly prisma: PrismaService) {
    this.inbox = new SqlInboxStore(prisma as unknown as TransactionalSqlClient);
  }

  async nextNumber(prefix: string, year: number): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ last: number }[]>`
      INSERT INTO document_counters (prefix, year, last) VALUES (${prefix}, ${year}, 1)
      ON CONFLICT (prefix, year) DO UPDATE SET last = document_counters.last + 1
      RETURNING last`;
    return Number(rows[0]!.last);
  }

  async create(document: DocumentRecord): Promise<boolean> {
    try {
      await this.prisma.document.create({
        data: {
          id: document.id,
          template: document.template,
          templateVersion: document.templateVersion,
          title: document.title,
          number: document.number,
          status: document.status,
          subjectType: document.subject.type,
          subjectId: document.subject.id,
          ownerId: document.ownerId,
          producerService: document.producerService,
          idempotencyKey: document.idempotencyKey,
          fileId: document.fileId,
          sha256: document.sha256,
          sizeBytes: document.sizeBytes,
          createdAt: document.createdAt,
        },
      });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  async findById(id: string): Promise<DocumentRecord | null> {
    const row = await this.prisma.document.findUnique({ where: { id } });
    return row ? toDocument(row) : null;
  }

  async findByIdempotencyKey(producerService: string, key: string): Promise<DocumentRecord | null> {
    const row = await this.prisma.document.findUnique({
      where: { producerService_idempotencyKey: { producerService, idempotencyKey: key } },
    });
    return row ? toDocument(row) : null;
  }

  async findRequestById(id: string): Promise<SignatureRequestRecord | null> {
    const row = await this.prisma.signatureRequest.findUnique({ where: { id } });
    return row ? toRequest(row) : null;
  }

  async findRequestByTokenHash(tokenHash: string): Promise<SignatureRequestRecord | null> {
    const row = await this.prisma.signatureRequest.findUnique({ where: { tokenHash } });
    return row ? toRequest(row) : null;
  }

  async findRequestByIdempotencyKey(documentId: string, key: string): Promise<SignatureRequestRecord | null> {
    const row = await this.prisma.signatureRequest.findUnique({
      where: { documentId_idempotencyKey: { documentId, idempotencyKey: key } },
    });
    return row ? toRequest(row) : null;
  }

  async latestRequest(documentId: string): Promise<SignatureRequestRecord | null> {
    const row = await this.prisma.signatureRequest.findFirst({
      where: { documentId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return row ? toRequest(row) : null;
  }

  async isSigner(documentId: string, userId: string): Promise<boolean> {
    const count = await this.prisma.signatureRequest.count({ where: { documentId, signerUserId: userId } });
    return count > 0;
  }

  async openRequest(request: SignatureRequestRecord, expected: readonly DocumentStatus[]): Promise<boolean> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.document.updateMany({
          where: { id: request.documentId, status: { in: [...expected] } },
          data: { status: 'pending_signature' },
        });
        if (count === 0) return false;
        await tx.signatureRequest.create({
          data: {
            id: request.id,
            documentId: request.documentId,
            status: request.status,
            signerUserId: request.signerUserId,
            signerPhoneE164: request.signerPhoneE164,
            signerEmail: request.signerEmail,
            signerPhoneMasked: request.signerPhoneMasked,
            signerName: request.signerName,
            tokenHash: request.tokenHash,
            documentSha256: request.documentSha256,
            idempotencyKey: request.idempotencyKey,
            createdAt: request.createdAt,
            expiresAt: request.expiresAt,
          },
        });
        return true;
      });
    } catch (error) {
      // Autre demande ouverte au même instant (une seule en attente par document) : refusée.
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  async abortRequest(requestId: string, documentId: string, restore: DocumentStatus): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.signatureRequest.deleteMany({ where: { id: requestId, status: 'pending' } });
      if (count === 0) return;
      await tx.document.updateMany({
        where: { id: documentId, status: 'pending_signature' },
        data: { status: restore },
      });
    });
  }

  async cancelDocument(id: string, input: { reason: string | null; now: Date }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.document.updateMany({
        where: { id, status: { in: ['draft', 'pending_signature', 'expired'] } },
        data: { status: 'cancelled', cancelledAt: input.now, cancellationReason: input.reason },
      });
      if (count === 0) return false;
      await tx.signatureRequest.updateMany({
        where: { documentId: id, status: 'pending' },
        data: { status: 'cancelled', closedAt: input.now, ...CLOSE },
      });
      return true;
    });
  }

  async expireRequest(requestId: string, now: Date): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.signatureRequest.findUnique({ where: { id: requestId } });
      if (!request) return false;
      const { count } = await tx.signatureRequest.updateMany({
        where: { id: requestId, status: 'pending', expiresAt: { lte: now } },
        data: { status: 'expired', closedAt: now, ...CLOSE },
      });
      if (count === 0) return false;
      await tx.document.updateMany({
        where: { id: request.documentId, status: 'pending_signature' },
        data: { status: 'expired' },
      });
      return true;
    });
  }

  async expireDue(now: Date, limit: number): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      // Lot verrouillé : plusieurs instances se partagent les demandes sans les traiter deux fois.
      const due = await tx.$queryRaw<{ id: string; document_id: string }[]>`
        SELECT id, document_id FROM signature_requests
        WHERE status = 'pending' AND expires_at <= ${now}
        ORDER BY expires_at LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
      if (due.length === 0) return 0;
      await tx.signatureRequest.updateMany({
        where: { id: { in: due.map((row) => row.id) }, status: 'pending' },
        data: { status: 'expired', closedAt: now, ...CLOSE },
      });
      await tx.document.updateMany({
        where: { id: { in: due.map((row) => row.document_id) }, status: 'pending_signature' },
        data: { status: 'expired' },
      });
      return due.length;
    });
  }

  async codeSentDates(requestId: string, since: Date): Promise<Date[]> {
    const rows = await this.prisma.signatureCode.findMany({
      where: { requestId, createdAt: { gte: since } },
      select: { createdAt: true },
    });
    return rows.map((row) => row.createdAt);
  }

  async createCode(code: SignatureCode): Promise<void> {
    await this.prisma.signatureCode.create({
      data: {
        id: code.id,
        requestId: code.requestId,
        codeHash: code.codeHash,
        channel: code.channel,
        createdAt: code.createdAt,
        expiresAt: code.expiresAt,
        attempts: code.attempts,
      },
    });
  }

  async setCodeChannel(codeId: string, channel: CodeChannel): Promise<void> {
    await this.prisma.signatureCode.updateMany({ where: { id: codeId }, data: { channel } });
  }

  async deleteCode(codeId: string): Promise<void> {
    await this.prisma.signatureCode.deleteMany({ where: { id: codeId, consumedAt: null } });
  }

  async activeCode(requestId: string, now: Date, maxAttempts: number): Promise<SignatureCode | null> {
    // Seul le dernier code envoyé compte : un nouveau code remplace les précédents.
    const row = await this.prisma.signatureCode.findFirst({
      where: { requestId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (!row || row.consumedAt || row.expiresAt <= now || row.attempts >= maxAttempts) return null;
    return toCode(row);
  }

  async recordFailedAttempt(codeId: string): Promise<number> {
    const row = await this.prisma.signatureCode.update({
      where: { id: codeId },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });
    return row.attempts;
  }

  async completeSignature(completion: SignatureCompletion): Promise<boolean> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const code = await tx.signatureCode.updateMany({
          where: { id: completion.codeId, requestId: completion.requestId, consumedAt: null },
          data: { consumedAt: completion.signedAt },
        });
        if (code.count === 0) throw new Rollback();
        const request = await tx.signatureRequest.updateMany({
          where: { id: completion.requestId, status: 'pending' },
          data: { status: 'signed', signedAt: completion.signedAt, closedAt: completion.signedAt, ...CLOSE },
        });
        if (request.count === 0) throw new Rollback();
        const document = await tx.document.updateMany({
          where: { id: completion.documentId, status: 'pending_signature' },
          data: {
            status: 'signed',
            signedAt: completion.signedAt,
            signedFileId: completion.signedFileId,
            signedSha256: completion.signedSha256,
          },
        });
        if (document.count === 0) throw new Rollback();
        const { evidence } = completion;
        await tx.signatureEvidence.create({
          data: {
            id: evidence.id,
            requestId: evidence.requestId,
            documentId: evidence.documentId,
            signedAt: evidence.signedAt,
            method: evidence.method,
            channel: evidence.channel,
            codeId: evidence.codeId,
            signerUserId: evidence.signerUserId,
            signerName: evidence.signerName,
            signerPhoneMasked: evidence.signerPhoneMasked,
            ip: evidence.ip,
            userAgent: evidence.userAgent,
            documentSha256: evidence.documentSha256,
            signedFileId: evidence.signedFileId,
            signedSha256: evidence.signedSha256,
            consent: evidence.consent,
            certificateVersion: evidence.certificateVersion,
          },
        });
        await appendToOutbox(
          tx as unknown as SqlExecutor,
          createEnvelope('document.signature.completed', completion.event, {
            producer: 'document',
            occurredAt: completion.signedAt,
          }),
        );
        return true;
      });
    } catch (error) {
      if (error instanceof Rollback) return false;
      throw error;
    }
  }

  async eraseAccount(
    userId: string,
    input: { eventId: string; consumer: string; now: Date },
  ): Promise<AccountErasure> {
    let detachedDocuments = 0;
    let cancelledRequests = 0;
    const status = await this.inbox.runOnce(input.eventId, input.consumer, async (tx: SqlExecutor) => {
      // Demandes en attente adressées au compte : sans signataire, elles n'aboutiront plus.
      const pending = await tx.$queryRawUnsafe<{ document_id: string }[]>(
        "UPDATE signature_requests SET status = 'cancelled', closed_at = $2::timestamptz, " +
          'signer_phone_e164 = NULL, signer_email = NULL ' +
          "WHERE signer_user_id = $1::uuid AND status = 'pending' RETURNING document_id",
        userId,
        input.now.toISOString(),
      );
      cancelledRequests = pending.length;
      if (pending.length > 0) {
        await tx.$executeRawUnsafe(
          "UPDATE documents SET status = 'draft' WHERE id = ANY($1::uuid[]) AND status = 'pending_signature'",
          pending.map((row) => row.document_id),
        );
      }
      // Plus aucun lien avec le compte ; le nom et le téléphone masqués restent dans la preuve.
      await tx.$executeRawUnsafe(
        'UPDATE signature_requests SET signer_user_id = NULL WHERE signer_user_id = $1::uuid',
        userId,
      );
      await tx.$executeRawUnsafe(
        'UPDATE signature_evidence SET signer_user_id = NULL WHERE signer_user_id = $1::uuid',
        userId,
      );
      detachedDocuments = await tx.$executeRawUnsafe(
        'UPDATE documents SET owner_id = NULL WHERE owner_id = $1::uuid',
        userId,
      );
    });
    return status === 'duplicate'
      ? { status, detachedDocuments: 0, cancelledRequests: 0 }
      : { status, detachedDocuments, cancelledRequests };
  }
}

/** Annule la transaction sans erreur : un changement d'état attendu n'a pas eu lieu. */
class Rollback extends Error {}
