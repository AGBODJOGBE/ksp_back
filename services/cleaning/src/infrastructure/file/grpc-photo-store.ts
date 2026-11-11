import { type fileV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { type InterventionPhotoStore, type StoredPhoto } from '../../application/ports';

/** Objet métier des photos chez file (ADR-038) : le passage. */
const SUBJECT_TYPE = 'cleaning_intervention';

const date = (value: string | undefined): Date | null => (value ? new Date(value) : null);

/**
 * Photos des passages chez le service file (FileInternalService, jeton de service de cleaning,
 * ADR-038, ADR-053). Les erreurs de file (FILE_NOT_FOUND, FILE_OWNER_MISMATCH…) sont transmises telles
 * quelles. Aucune adresse présignée n'est journalisée.
 */
export class GrpcPhotoStore implements InterventionPhotoStore {
  constructor(
    private readonly client: fileV1.FileInternalServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async attach(input: { fileId: string; interventionId: string; ownerId: string }): Promise<void> {
    // Idempotent chez file pour le même objet : peut être rejoué.
    await this.caller.call(
      'attachFile',
      (metadata) =>
        this.client.attachFile(
          {
            fileId: input.fileId,
            subject: { type: SUBJECT_TYPE, id: input.interventionId },
            ownerId: input.ownerId,
          },
          metadata,
        ),
      { idempotent: true },
    );
  }

  async remove(fileId: string, interventionId: string): Promise<void> {
    await this.caller.call(
      'deleteFile',
      (metadata) =>
        this.client.deleteFile({ fileId, subject: { type: SUBJECT_TYPE, id: interventionId } }, metadata),
      { idempotent: true },
    );
  }

  async list(interventionId: string): Promise<StoredPhoto[]> {
    const response = await this.caller.call(
      'listFiles',
      (metadata) =>
        this.client.listFiles(
          { subject: { type: SUBJECT_TYPE, id: interventionId }, includeDownloadUrls: true },
          metadata,
        ),
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
