import { type fileV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { type PdfStore } from '../../application/ports';
import { FILE_SUBJECT_TYPE } from '../../domain/document';
import { callDependency, dependencyError } from '../dependencies';

/** Finalité des PDF produits par document (ADR-038). */
const PURPOSE = 'generated_document';
/** Limite de la finalité chez file : aucun PDF lu au-delà. */
const MAX_BYTES = 20 * 1024 * 1024;

export interface PdfStoreOptions {
  /** Délai d'un envoi ou d'une lecture du contenu dans le stockage. */
  transferTimeoutMs: number;
  /** Remplaçable dans les tests. */
  fetch?: typeof fetch;
}

/**
 * Stockage des PDF par le service file (FileInternalService, jeton de service) : déclaration,
 * envoi du contenu par l'adresse PUT présignée, confirmation ; lecture par une adresse GET de courte
 * durée. Les fichiers sont rattachés à l'objet « document_file » de même identifiant que le
 * document. Aucune adresse présignée n'est journalisée.
 */
export class GrpcPdfStore implements PdfStore {
  private readonly fetch: typeof fetch;

  constructor(
    private readonly client: fileV1.FileInternalServiceClient,
    private readonly caller: GrpcCaller,
    private readonly options: PdfStoreOptions,
  ) {
    this.fetch = options.fetch ?? fetch;
  }

  async store(input: {
    documentId: string;
    fileName: string;
    bytes: Uint8Array;
    ownerId: string | null;
  }): Promise<{ fileId: string }> {
    const ticket = await callDependency(this.caller, 'file', 'createServiceUpload', (metadata) =>
      this.client.createServiceUpload(
        {
          purpose: PURPOSE,
          fileName: input.fileName,
          contentType: 'application/pdf',
          sizeBytes: input.bytes.byteLength,
          subject: { type: FILE_SUBJECT_TYPE, id: input.documentId },
          ownerId: input.ownerId ?? '',
        },
        metadata,
      ),
    );
    const fileId = ticket.file?.id;
    if (!fileId || !ticket.upload?.url) throw dependencyError('file', 'createServiceUpload', null);
    try {
      const response = await this.fetch(ticket.upload.url, {
        method: 'PUT',
        headers: ticket.upload.headers,
        body: input.bytes,
        signal: AbortSignal.timeout(this.options.transferTimeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch {
      throw dependencyError('file', 'upload', null);
    }
    // La confirmation relit le contenu dans le stockage : délai plus long.
    await callDependency(
      this.caller,
      'file',
      'completeServiceUpload',
      (metadata) => this.client.completeServiceUpload({ fileId }, metadata),
      { deadlineMs: 10_000 },
    );
    return { fileId };
  }

  async read(fileId: string, documentId: string): Promise<Uint8Array> {
    const { url } = await this.downloadUrl(fileId, documentId);
    try {
      const response = await this.fetch(url, { signal: AbortSignal.timeout(this.options.transferTimeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_BYTES) throw new Error('trop volumineux');
      return bytes;
    } catch {
      throw dependencyError('file', 'download', null);
    }
  }

  async downloadUrl(fileId: string, documentId: string): Promise<{ url: string; expiresAt: Date }> {
    const response = await callDependency(
      this.caller,
      'file',
      'createDownloadUrl',
      (metadata) =>
        this.client.createDownloadUrl(
          { fileId, subject: { type: FILE_SUBJECT_TYPE, id: documentId } },
          metadata,
        ),
      { idempotent: true },
    );
    if (!response.download?.url) throw dependencyError('file', 'createDownloadUrl', null);
    return { url: response.download.url, expiresAt: new Date(response.download.expiresAt) };
  }

  async remove(fileId: string, documentId: string): Promise<void> {
    await callDependency(this.caller, 'file', 'deleteFile', (metadata) =>
      this.client.deleteFile({ fileId, subject: { type: FILE_SUBJECT_TYPE, id: documentId } }, metadata),
    );
  }
}
