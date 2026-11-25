import { type documentV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { type DocumentCancellation } from '../../application/amicable/amicable.ports';
import { callDependency } from './dependency';

/**
 * Annulation d'un document non signé chez document (CancelDocument, ADR-044) : protocole d'échéancier
 * remplacé par un nouvel envoi du lien de signature. Idempotente chez document.
 */
export class GrpcDocumentCancellation implements DocumentCancellation {
  constructor(
    private readonly client: documentV1.DocumentInternalServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async cancel(input: { documentId: string; reason: string }): Promise<void> {
    await callDependency<documentV1.CancelDocumentResponse>(
      'document',
      this.caller,
      'cancelDocument',
      (metadata) =>
        this.client.cancelDocument({ documentId: input.documentId, reason: input.reason }, metadata),
      { idempotent: true },
    );
  }
}
