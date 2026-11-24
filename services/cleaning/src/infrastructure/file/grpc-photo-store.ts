import { type fileV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { type FileSubject, type PhotoStore, type StoredPhoto } from '../../application/ports';

const date = (value: string | undefined): Date | null => (value ? new Date(value) : null);

/**
 * Photos et pièces chez le service file (FileInternalService, jeton de service de cleaning,
 * ADR-038), paramétrées par type d'objet (reprise RV-102). Les erreurs de file (FILE_NOT_FOUND,
 * FILE_OWNER_MISMATCH…) sont transmises telles quelles. Aucune adresse présignée n'est journalisée.
 */
export class GrpcPhotoStore implements PhotoStore {
  constructor(
    private readonly client: fileV1.FileInternalServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async attach(input: { fileId: string; subject: FileSubject; ownerId: string }): Promise<void> {
    // Idempotent chez file pour le même objet : peut être rejoué.
    await this.caller.call(
      'attachFile',
      (metadata) =>
        this.client.attachFile(
          { fileId: input.fileId, subject: { ...input.subject }, ownerId: input.ownerId },
          metadata,
        ),
      { idempotent: true },
    );
  }

  async remove(fileId: string, subject: FileSubject): Promise<void> {
    await this.caller.call(
      'deleteFile',
      (metadata) => this.client.deleteFile({ fileId, subject: { ...subject } }, metadata),
      { idempotent: true },
    );
  }

  async list(subject: FileSubject): Promise<StoredPhoto[]> {
    const response = await this.caller.call(
      'listFiles',
      (metadata) => this.client.listFiles({ subject: { ...subject }, includeDownloadUrls: true }, metadata),
      { idempotent: true },
    );
    return response.files.flatMap(({ file, download }) =>
      file
        ? [
            {
              fileId: file.id,
              fileName: file.fileName,
              contentType: file.contentType,
              sizeBytes: Number(file.sizeBytes),
              uploadedAt: date(file.createdAt) ?? new Date(0),
              downloadUrl: download?.url || null,
              downloadExpiresAt: date(download?.expiresAt),
            },
          ]
        : [],
    );
  }
}
