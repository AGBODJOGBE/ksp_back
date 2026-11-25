import { type documentV1, type fileV1 } from '@ksp/contracts';
import { AppError, type GrpcCaller } from '@ksp/platform';
import {
  type DebtorUploads,
  type DocumentUrls,
  type UploadSlot,
} from '../../application/debtor-space/debtor-space.ports';
import { callDependency } from './dependency';

/** Finalité des pièces envoyées par un débiteur sans compte (file, ADR-038). */
export const DEBTOR_EVIDENCE_PURPOSE = 'recovery_debtor_evidence';

const caseSubject = (caseId: string) => ({ type: 'recovery_case', id: caseId });

/**
 * Pièces du débiteur chez file (FileInternalService) : recovery déclare le fichier pour lui (finalité
 * `recovery_debtor_evidence`, envoyée par le service), rattaché au dossier dès la déclaration ; file
 * vérifie le contenu à la confirmation. Les adresses présignées ne sont jamais journalisées.
 */
export class GrpcDebtorUploads implements DebtorUploads {
  constructor(
    private readonly client: fileV1.FileInternalServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async create(input: {
    caseId: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  }): Promise<UploadSlot> {
    const res = await callDependency<fileV1.CreateServiceUploadResponse>(
      'file',
      this.caller,
      'createServiceUpload',
      (metadata) =>
        this.client.createServiceUpload(
          {
            purpose: DEBTOR_EVIDENCE_PURPOSE,
            fileName: input.fileName,
            contentType: input.contentType,
            sizeBytes: input.sizeBytes,
            subject: caseSubject(input.caseId),
            ownerId: '',
          },
          metadata,
        ),
    );
    if (!res.file?.id || !res.upload?.url) throw new Error('Réponse de file sans envoi.');
    return {
      fileId: res.file.id,
      url: res.upload.url,
      expiresAt: res.upload.expiresAt,
      headers: res.upload.headers ?? {},
    };
  }

  async complete(fileId: string) {
    try {
      const res = await callDependency<fileV1.CompleteServiceUploadResponse>(
        'file',
        this.caller,
        'completeServiceUpload',
        (metadata) => this.client.completeServiceUpload({ fileId }, metadata),
        { idempotent: true },
      );
      const file = res.file;
      if (!file?.id) throw new Error('Réponse de file sans fichier.');
      return {
        fileId: file.id,
        status: (file.status === 'available' || file.status === 'rejected' ? file.status : 'pending') as
          'available' | 'rejected' | 'pending',
        fileName: file.fileName,
        subject: file.subject?.id ? { type: file.subject.type, id: file.subject.id } : null,
      };
    } catch (error) {
      // Contenu refusé (taille, type, logiciel malveillant) : le fichier passe en « rejected ».
      if (error instanceof AppError && error.code === 'FILE_UPLOAD_REJECTED') {
        return { fileId, status: 'rejected' as const, fileName: '', subject: null };
      }
      throw error;
    }
  }

  async readUrl(input: { fileId: string; caseId: string }) {
    const res = await callDependency<fileV1.CreateDownloadUrlResponse>(
      'file',
      this.caller,
      'createDownloadUrl',
      (metadata) =>
        this.client.createDownloadUrl({ fileId: input.fileId, subject: caseSubject(input.caseId) }, metadata),
      { idempotent: true },
    );
    if (!res.download?.url) throw new Error('Réponse de file sans adresse de lecture.');
    return { url: res.download.url, expiresAt: res.download.expiresAt };
  }
}

/** Adresses de lecture des documents produits (DocumentInternalService.CreateDownloadUrl). */
export class GrpcDocumentUrls implements DocumentUrls {
  constructor(
    private readonly client: documentV1.DocumentInternalServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async readUrl(documentId: string) {
    const res = await callDependency<documentV1.CreateDownloadUrlResponse>(
      'document',
      this.caller,
      'createDownloadUrl',
      (metadata) => this.client.createDownloadUrl({ documentId, version: 'current' }, metadata),
      { idempotent: true },
    );
    if (!res.download?.url) throw new Error('Réponse de document sans adresse de lecture.');
    return { url: res.download.url, expiresAt: res.download.expiresAt };
  }
}
