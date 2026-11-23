import { type fileV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { type Files } from '../../application/ports';
import { callDependency } from './dependency';

/**
 * Fichiers du recouvrement chez file (FileInternalService, ADR-038) : une pièce déposée par le
 * créancier, le débiteur ou un partenaire est rattachée au dossier (finalité `recovery_evidence`).
 * Rattacher est idempotent pour le même objet.
 */
export class GrpcFiles implements Files {
  constructor(
    private readonly client: fileV1.FileInternalServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async attach(input: Parameters<Files['attach']>[0]): Promise<{
    fileId: string;
    contentType: string;
    sizeBytes: number;
  }> {
    const res = await callDependency<fileV1.AttachFileResponse>(
      'file',
      this.caller,
      'attachFile',
      (metadata) =>
        this.client.attachFile(
          { fileId: input.fileId, subject: input.subject, ownerId: input.ownerId ?? '' },
          metadata,
        ),
      { idempotent: true },
    );
    if (!res.file?.id) throw new Error('Réponse de file sans fichier.');
    return { fileId: res.file.id, contentType: res.file.contentType, sizeBytes: Number(res.file.sizeBytes) };
  }
}
