import { type documentV1 } from '@ksp/contracts';
import { type DocumentView, type SignatureView } from '../../application/shared';
import { type CodeDelivery } from '../../application/signature-codes';
import { type SigningSessionView } from '../../application/signing.use-cases';

const iso = (value: Date | null) => (value ? value.toISOString() : '');

/** Demande de signature ksp.document.v1 : jamais le téléphone en clair ni le jeton du lien. */
export function presentSignature(view: SignatureView): documentV1.SignatureRequest {
  const { request } = view;
  return {
    id: request.id,
    documentId: request.documentId,
    status: view.status,
    signer: {
      userId: request.signerUserId ?? '',
      phoneMasked: request.signerPhoneMasked,
      displayName: request.signerName,
    },
    createdAt: iso(request.createdAt),
    expiresAt: iso(request.expiresAt),
    signedAt: iso(request.signedAt),
    codeExpiresAt: iso(view.codeExpiresAt),
  };
}

export function presentDocument(view: DocumentView): documentV1.Document {
  const { document } = view;
  return {
    id: document.id,
    template: document.template,
    templateVersion: document.templateVersion,
    title: document.title,
    number: document.number,
    status: document.status,
    subject: { type: document.subject.type, id: document.subject.id },
    ownerId: document.ownerId ?? '',
    fileId: document.fileId,
    sha256: document.sha256,
    sizeBytes: document.sizeBytes,
    signedFileId: document.signedFileId ?? '',
    signedSha256: document.signedSha256 ?? '',
    createdAt: iso(document.createdAt),
    signedAt: iso(document.signedAt),
    cancelledAt: iso(document.cancelledAt),
    signature: view.signature ? presentSignature(view.signature) : undefined,
  };
}

export function presentDownload(link: {
  url: string;
  expiresAt: Date;
  version: 'original' | 'signed';
}): documentV1.DownloadUrl {
  return { url: link.url, expiresAt: link.expiresAt.toISOString(), version: link.version };
}

export function presentDelivery(delivery: CodeDelivery): documentV1.CodeDelivery {
  return {
    channel: delivery.channel,
    expiresAt: delivery.expiresAt.toISOString(),
    resendAfterSeconds: delivery.resendAfterSeconds,
  };
}

export function presentSession(session: SigningSessionView): documentV1.SigningSession {
  return {
    documentTitle: session.documentTitle,
    documentNumber: session.documentNumber,
    status: session.status,
    signer: {
      // Lien sans compte : aucun identifiant de compte exposé.
      userId: '',
      phoneMasked: session.request.signerPhoneMasked,
      displayName: session.request.signerName,
    },
    expiresAt: iso(session.request.expiresAt),
    signedAt: iso(session.request.signedAt),
    codeExpiresAt: iso(session.codeExpiresAt),
    download: session.download ? presentDownload(session.download) : undefined,
  };
}
