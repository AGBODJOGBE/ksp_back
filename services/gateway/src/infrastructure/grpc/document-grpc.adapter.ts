import { type Metadata } from '@grpc/grpc-js';
import { type documentV1 } from '@ksp/contracts';
import { AppError, currentContext, type GrpcCaller } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { type Observable } from 'rxjs';
import { type Json } from '../../application/cleaning/cleaning.ports';
import { type DocumentApi, type SignInput } from '../../application/document/document.ports';
import { toUpstreamError } from './upstream-error';

/** Réponse de document qui ne respecte pas le contrat : erreur interne, jamais transmise telle quelle. */
const malformed = (what: string) =>
  new AppError('INTERNAL', 'GATEWAY_UPSTREAM_ERROR', `Réponse de document inattendue (${what}).`);
const orNull = (value: string | undefined): string | null => (value ? value : null);
/** La signature relit le PDF, ajoute le certificat et le stocke : délai plus long. */
const SIGN_DEADLINE_MS = 20_000;
/** L'envoi d'un code attend la réponse de notification (WhatsApp ou e-mail). */
const CODE_DEADLINE_MS = 8_000;

/** Demande de signature : le signataire est désigné par son nom et son téléphone masqué. */
function presentSignature(value: documentV1.SignatureRequest | undefined) {
  if (!value) return null;
  const caller = currentContext()?.user?.userId;
  return {
    id: value.id,
    status: value.status,
    signer: {
      displayName: value.signer?.displayName ?? '',
      phoneMasked: orNull(value.signer?.phoneMasked),
      hasAccount: Boolean(value.signer?.userId),
    },
    // Le compte connecté est le signataire attendu : l'espace KSP propose de signer.
    canSign: value.status === 'pending' && Boolean(caller) && value.signer?.userId === caller,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    signedAt: orNull(value.signedAt),
    codeExpiresAt: orNull(value.codeExpiresAt),
  };
}

/** Traduction d'un document ksp.document.v1 vers le JSON du contrat OpenAPI (sans identifiant de fichier). */
export function presentDocument(value: documentV1.Document | undefined) {
  if (!value?.id) throw malformed('document');
  return {
    id: value.id,
    template: value.template,
    templateVersion: value.templateVersion,
    title: value.title,
    number: value.number,
    status: value.status,
    subject: value.subject?.type ? { type: value.subject.type, id: value.subject.id } : null,
    sha256: value.sha256,
    sizeBytes: Number(value.sizeBytes),
    signedSha256: orNull(value.signedSha256),
    createdAt: value.createdAt,
    signedAt: orNull(value.signedAt),
    cancelledAt: orNull(value.cancelledAt),
    signature: presentSignature(value.signature),
  };
}

function presentDownload(value: documentV1.DownloadUrl | undefined) {
  if (!value?.url) throw malformed('adresse de lecture');
  return { url: value.url, expiresAt: value.expiresAt, version: value.version };
}

function presentDelivery(value: documentV1.CodeDelivery | undefined) {
  if (!value?.channel) throw malformed('envoi du code');
  return { channel: value.channel, expiresAt: value.expiresAt, resendAfterSeconds: value.resendAfterSeconds };
}

function presentSession(value: documentV1.SigningSession | undefined) {
  if (!value?.documentNumber) throw malformed('demande de signature');
  return {
    documentTitle: value.documentTitle,
    documentNumber: value.documentNumber,
    status: value.status,
    signer: {
      displayName: value.signer?.displayName ?? '',
      phoneMasked: orNull(value.signer?.phoneMasked),
    },
    expiresAt: value.expiresAt,
    signedAt: orNull(value.signedAt),
    codeExpiresAt: orNull(value.codeExpiresAt),
    download: value.download?.url ? presentDownload(value.download) : null,
  };
}

/**
 * Client gRPC de document : délai, coupe-circuit et jeton de service par GrpcCaller. Seules les
 * lectures sont rejouées. Ni le code, ni le jeton du lien, ni les adresses de lecture ne sont
 * journalisés.
 */
export class DocumentGrpcAdapter implements DocumentApi {
  private readonly logger = new Logger('DocumentGrpc');

  constructor(
    private readonly documents: documentV1.DocumentServiceClient,
    private readonly signing: documentV1.DocumentSigningServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async getMyDocument(id: string): Promise<Json> {
    const res = await this.call('getMyDocument', (m) => this.documents.getMyDocument({ documentId: id }, m), {
      idempotent: true,
    });
    return presentDocument(res.document);
  }

  async createMyDownloadUrl(id: string): Promise<Json> {
    const res = await this.call(
      'createMyDownloadUrl',
      (m) => this.documents.createMyDownloadUrl({ documentId: id }, m),
      { idempotent: true },
    );
    return presentDownload(res.download);
  }

  async sendSignatureCode(signatureRequestId: string): Promise<Json> {
    const res = await this.call(
      'sendSignatureCode',
      (m) => this.documents.sendSignatureCode({ signatureRequestId }, m),
      { deadlineMs: CODE_DEADLINE_MS },
    );
    return presentDelivery(res.delivery);
  }

  async signDocument(signatureRequestId: string, input: SignInput): Promise<Json> {
    const res = await this.call(
      'signDocument',
      (m) => this.documents.signDocument({ signatureRequestId, code: input.code, consent: input.consent }, m),
      { deadlineMs: SIGN_DEADLINE_MS },
    );
    return presentDocument(res.document);
  }

  async getSigningSession(token: string): Promise<Json> {
    const res = await this.call('getSigningSession', (m) => this.signing.getSigningSession({ token }, m), {
      idempotent: true,
    });
    return presentSession(res.session);
  }

  async sendSigningCode(token: string): Promise<Json> {
    const res = await this.call('sendSigningCode', (m) => this.signing.sendSigningCode({ token }, m), {
      deadlineMs: CODE_DEADLINE_MS,
    });
    return presentDelivery(res.delivery);
  }

  async signWithLink(token: string, input: SignInput): Promise<Json> {
    const res = await this.call(
      'signWithLink',
      (m) => this.signing.signWithLink({ token, code: input.code, consent: input.consent }, m),
      { deadlineMs: SIGN_DEADLINE_MS },
    );
    return presentSession(res.session);
  }

  private async call<T>(
    name: string,
    invoke: (metadata: Metadata) => Observable<T>,
    options: { idempotent?: boolean; deadlineMs?: number },
  ): Promise<T> {
    try {
      return await this.caller.call(name, invoke, options);
    } catch (error) {
      const upstream = toUpstreamError('document', error);
      if (upstream.code !== (error as AppError)?.code) {
        this.logger.warn(`document.${name} : ${(error as AppError)?.code ?? 'erreur'} → ${upstream.code}`);
      }
      throw upstream;
    }
  }
}
