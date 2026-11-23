import { type documentV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { type Documents, type GeneratedDocument } from '../../application/ports';
import { callDependency } from './dependency';

/** Modèle dont le rendu est long (jusqu'à 1 000 entrées) : échéance propre (ADR-060). */
const LONG_TEMPLATES = new Set(['recovery_evidence_log']);

/**
 * Documents PDF et signature par code chez document (DocumentInternalService, ADR-044), avec le jeton
 * de service de recovery. Production idempotente par clé ; les variables ne sont pas conservées par
 * document (le PDF fait foi). Le journal de preuve a une échéance de 15 secondes.
 */
export class GrpcDocuments implements Documents {
  constructor(
    private readonly client: documentV1.DocumentInternalServiceClient,
    private readonly caller: GrpcCaller,
    private readonly longDeadlineMs: number,
  ) {}

  async generate(input: Parameters<Documents['generate']>[0]): Promise<GeneratedDocument> {
    const res = await callDependency<documentV1.GenerateDocumentResponse>(
      'document',
      this.caller,
      'generateDocument',
      (metadata) =>
        this.client.generateDocument(
          {
            template: input.template,
            templateVersion: 0,
            variablesJson: JSON.stringify(input.variables),
            subject: input.subject,
            ownerId: input.ownerId ?? '',
            idempotencyKey: input.idempotencyKey,
          },
          metadata,
        ),
      {
        idempotent: true,
        ...(LONG_TEMPLATES.has(input.template) ? { deadlineMs: this.longDeadlineMs } : {}),
      },
    );
    const document = res.document;
    if (!document?.id) throw new Error('Réponse de document sans document.');
    return { id: document.id, number: document.number, status: document.status, fileId: document.fileId };
  }

  async requestSignature(
    input: Parameters<Documents['requestSignature']>[0],
  ): Promise<{ signatureId: string; status: string }> {
    const res = await callDependency<documentV1.RequestSignatureResponse>(
      'document',
      this.caller,
      'requestSignature',
      (metadata) =>
        this.client.requestSignature(
          {
            documentId: input.documentId,
            signer: {
              userId: input.signer.userId ?? '',
              phoneE164: input.signer.phone ?? '',
              email: input.signer.email ?? '',
              displayName: input.signer.displayName,
            },
            expiresInHours: input.expiresInHours ?? 0,
            notice: input.notice ?? '',
            idempotencyKey: input.idempotencyKey,
          },
          metadata,
        ),
      { idempotent: true },
    );
    if (!res.signature?.id) throw new Error('Réponse de document sans demande de signature.');
    return { signatureId: res.signature.id, status: res.signature.status };
  }
}
