import { currentContext, requireUser } from '@ksp/platform';
import { CERTIFICATE_VERSION, certificateContent } from '../domain/certificate';
import { normalizeCode } from '../domain/code-policy';
import { type DocumentRecord, pdfFileName } from '../domain/document';
import {
  cleanIp,
  cleanUserAgent,
  effectiveStatus,
  type SignatureEvidence,
  type SignatureRequestRecord,
} from '../domain/signature';
import { DocumentErrors } from './errors';
import { type DocumentDeps } from './ports';
import { downloadOf } from './request-signature.use-cases';
import { documentIdOrNotFound, type DocumentView, signatureViewOf, viewOf } from './shared';
import { type CodeDelivery, SignatureCodes } from './signature-codes';

/** Jeton du lien : 32 octets en base64url (43 caractères). */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Ce que voit un signataire sans compte : le document à signer, rien d'autre. */
export interface SigningSessionView {
  documentTitle: string;
  documentNumber: string;
  request: SignatureRequestRecord;
  status: ReturnType<typeof effectiveStatus>;
  codeExpiresAt: Date | null;
  download: { url: string; expiresAt: Date; version: 'original' | 'signed' } | null;
}

/**
 * Parcours de signature commun au signataire connecté et au lien (ADR-044) : envoi du code,
 * vérification, contrôle de l'empreinte du PDF stocké, page de certificat, preuve et événement.
 */
class SignatureFlow {
  readonly codes: SignatureCodes;

  constructor(private readonly deps: DocumentDeps) {
    this.codes = new SignatureCodes(deps);
  }

  async documentOf(request: SignatureRequestRecord): Promise<DocumentRecord> {
    const document = await this.deps.documents.findById(request.documentId);
    if (!document) throw DocumentErrors.signatureNotFound();
    return document;
  }

  async sendCode(request: SignatureRequestRecord): Promise<CodeDelivery> {
    return this.codes.send(await this.documentOf(request), request);
  }

  async sign(
    request: SignatureRequestRecord,
    input: { code?: string; consent?: boolean },
  ): Promise<DocumentRecord> {
    const { documents, clock, secrets, pdfs, renderer, settings, ids } = this.deps;
    const policy = settings.codePolicy;
    if (input.consent !== true) throw DocumentErrors.consentRequired();
    const code = normalizeCode(input.code, policy.length);

    const now = clock.now();
    const status = effectiveStatus(request, now);
    if (status !== 'pending') {
      if (status === 'expired' && request.status === 'pending')
        await documents.expireRequest(request.id, now);
      throw DocumentErrors.signatureClosed(status);
    }
    const document = await this.documentOf(request);
    if (document.status !== 'pending_signature') throw DocumentErrors.invalidStatus(document.status);

    const active = await documents.activeCode(request.id, now, policy.maxAttempts);
    if (!active) throw DocumentErrors.codeExpired();
    if (!code || !secrets.codeMatches(active.id, code, active.codeHash)) {
      const attempts = await documents.recordFailedAttempt(active.id);
      throw DocumentErrors.codeInvalid(Math.max(policy.maxAttempts - attempts, 0));
    }

    // Le PDF stocké doit être exactement celui produit et présenté : sinon, aucune signature.
    const original = await pdfs.read(document.fileId, document.id);
    const sha256 = secrets.sha256(original);
    if (sha256 !== document.sha256 || sha256 !== request.documentSha256)
      throw DocumentErrors.contentChanged();

    const context = currentContext()?.client;
    const ip = cleanIp(context?.ip);
    const userAgent = cleanUserAgent(context?.userAgent);
    const certificate = certificateContent({
      documentTitle: document.title,
      documentNumber: document.number,
      pageCount: await renderer.pageCount(original),
      documentSha256: sha256,
      signerName: request.signerName,
      signerHasAccount: request.signerUserId !== null,
      signerPhoneMasked: request.signerPhoneMasked,
      channel: active.channel,
      signedAt: now,
      ip,
      userAgent,
      signatureRequestId: request.id,
      issuerName: settings.issuer.name,
      timeZone: settings.timeZone,
    });
    const sealed = await renderer.appendCertificate(original, certificate, {
      title: document.title,
      createdAt: now,
    });
    const signedSha256 = secrets.sha256(sealed);
    const { fileId: signedFileId } = await pdfs.store({
      documentId: document.id,
      fileName: pdfFileName(document.number, true),
      bytes: sealed,
      ownerId: document.ownerId,
    });

    const evidence: SignatureEvidence = {
      id: ids.next(),
      requestId: request.id,
      documentId: document.id,
      signedAt: now,
      method: 'one_time_code',
      channel: active.channel,
      codeId: active.id,
      signerUserId: request.signerUserId,
      signerName: request.signerName,
      signerPhoneMasked: request.signerPhoneMasked,
      ip,
      userAgent,
      documentSha256: sha256,
      signedFileId,
      signedSha256,
      consent: true,
      certificateVersion: CERTIFICATE_VERSION,
    };
    const completed = await documents.completeSignature({
      requestId: request.id,
      documentId: document.id,
      codeId: active.id,
      signedAt: now,
      signedFileId,
      signedSha256,
      evidence,
      event: {
        documentId: document.id,
        signatureRequestId: request.id,
        template: document.template,
        templateVersion: document.templateVersion,
        producerService: document.producerService,
        subjectType: document.subject.type,
        subjectId: document.subject.id,
        ownerId: document.ownerId,
        signerUserId: request.signerUserId,
        method: 'one_time_code',
        channel: active.channel,
        documentSha256: sha256,
        signedFileId,
        signedDocumentSha256: signedSha256,
        signedAt: now.toISOString(),
      },
    });
    if (!completed) {
      // Signature simultanée (double envoi) ou demande close entre-temps : l'état enregistré fait foi.
      await pdfs.remove(signedFileId, document.id).catch(() => undefined);
      const current = await documents.findRequestById(request.id);
      if (current?.status === 'signed') return (await documents.findById(document.id)) ?? document;
      throw DocumentErrors.codeExpired();
    }
    return { ...document, status: 'signed', signedFileId, signedSha256, signedAt: now };
  }
}

/** Demande adressée au compte connecté ; sinon introuvable (aucun indice sur son existence). */
async function requestOfUser(
  deps: DocumentDeps,
  requestId: string | undefined,
): Promise<SignatureRequestRecord> {
  const user = requireUser();
  const id = (() => {
    try {
      return documentIdOrNotFound(requestId);
    } catch {
      throw DocumentErrors.signatureNotFound();
    }
  })();
  const request = await deps.documents.findRequestById(id);
  if (!request || request.signerUserId !== user.userId) throw DocumentErrors.signatureNotFound();
  return request;
}

/** Demande du lien de signature ; jeton inconnu ou mal formé : introuvable. */
async function requestOfToken(
  deps: DocumentDeps,
  token: string | undefined,
): Promise<SignatureRequestRecord> {
  if (!token || !TOKEN.test(token)) throw DocumentErrors.signatureNotFound();
  const request = await deps.documents.findRequestByTokenHash(deps.secrets.hashToken(token));
  if (!request) throw DocumentErrors.signatureNotFound();
  return request;
}

/** Signataire connecté : code et signature depuis « Mon espace KSP ». */
export class UserSignatureUseCases {
  private readonly flow: SignatureFlow;

  constructor(private readonly deps: DocumentDeps) {
    this.flow = new SignatureFlow(deps);
  }

  async sendCode(requestId: string | undefined): Promise<CodeDelivery> {
    return this.flow.sendCode(await requestOfUser(this.deps, requestId));
  }

  async sign(input: { requestId?: string; code?: string; consent?: boolean }): Promise<DocumentView> {
    const request = await requestOfUser(this.deps, input.requestId);
    return viewOf(this.deps, await this.flow.sign(request, input));
  }
}

/** Signataire sans compte, par le jeton du lien (route publique de la gateway). */
export class LinkSignatureUseCases {
  private readonly flow: SignatureFlow;

  constructor(private readonly deps: DocumentDeps) {
    this.flow = new SignatureFlow(deps);
  }

  async session(token: string | undefined): Promise<SigningSessionView> {
    return this.sessionOf(await requestOfToken(this.deps, token));
  }

  async sendCode(token: string | undefined): Promise<CodeDelivery> {
    return this.flow.sendCode(await requestOfToken(this.deps, token));
  }

  async sign(input: { token?: string; code?: string; consent?: boolean }): Promise<SigningSessionView> {
    const request = await requestOfToken(this.deps, input.token);
    await this.flow.sign(request, input);
    return this.sessionOf((await this.deps.documents.findRequestById(request.id)) ?? request);
  }

  private async sessionOf(request: SignatureRequestRecord): Promise<SigningSessionView> {
    const document = await this.flow.documentOf(request);
    const view = await signatureViewOf(this.deps, request, this.deps.clock.now());
    // Demande close sans signature : le document n'est plus montré.
    const readable = view.status === 'pending' || view.status === 'signed';
    const download = readable ? await downloadOf(this.deps, document, view.status === 'signed') : null;
    return {
      documentTitle: document.title,
      documentNumber: document.number,
      request,
      status: view.status,
      codeExpiresAt: view.codeExpiresAt,
      download,
    };
  }
}

/**
 * Lecture par l'espace connecté : le propriétaire du document, ou un compte qui en est (ou a été)
 * signataire. Tout autre compte reçoit « introuvable ».
 */
export class MyDocumentUseCases {
  constructor(private readonly deps: DocumentDeps) {}

  async get(documentId: string | undefined): Promise<DocumentView> {
    return viewOf(this.deps, await this.readable(documentId));
  }

  async downloadUrl(documentId: string | undefined) {
    const document = await this.readable(documentId);
    return downloadOf(this.deps, document, document.signedFileId !== null);
  }

  private async readable(documentId: string | undefined): Promise<DocumentRecord> {
    const user = requireUser();
    const document = await this.deps.documents.findById(documentIdOrNotFound(documentId));
    if (!document) throw DocumentErrors.notFound();
    const allowed =
      document.ownerId === user.userId || (await this.deps.documents.isSigner(document.id, user.userId));
    if (!allowed) throw DocumentErrors.notFound();
    return document;
  }
}
