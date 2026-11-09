import { canCancel, canRequestSignature, type DocumentRecord, type DocumentStatus } from '../domain/document';
import { formatLongDate } from '../domain/format';
import { hasControlCharacter } from '../domain/text';
import { maskPhone, parseEmail, parsePhone } from '../domain/phone';
import {
  DEFAULT_REQUEST_HOURS,
  effectiveStatus,
  MAX_REQUEST_HOURS,
  type SignatureRequestRecord,
} from '../domain/signature';
import { findTemplate } from '../domain/templates/catalog';
import { DocumentErrors } from './errors';
import { type Contact, type DocumentDeps } from './ports';
import {
  type DocumentView,
  ownsDocument,
  requireIdempotencyKey,
  requireInternalCaller,
  requireUuid,
  type SignatureView,
  signatureViewOf,
  viewOf,
} from './shared';
import { SignatureCodes } from './signature-codes';

export interface RequestSignatureInput {
  documentId?: string;
  signer?: { userId?: string; phoneE164?: string; email?: string; displayName?: string } | null;
  expiresInHours?: number;
  notice?: string;
  idempotencyKey?: string;
}

/** Lien de signature d'une personne sans compte (page du portail, chemin à valider). */
export function signingLink(portalBaseUrl: string, token: string): string {
  return `${portalBaseUrl}/signer/${token}`;
}

/** Page de signature d'un signataire connecté, dans « Mon espace KSP » (chemin à valider). */
export function accountSigningLink(portalBaseUrl: string, documentId: string): string {
  return `${portalBaseUrl}/mon-espace/documents/${documentId}`;
}

/** Document du service appelant, à l'état réel (une demande expirée est close au passage). */
async function loadOwnDocument(deps: DocumentDeps, caller: string, documentId: string | undefined) {
  const id = requireUuid('documentId', documentId);
  let document = await deps.documents.findById(id);
  if (!document || !ownsDocument(document, caller)) throw DocumentErrors.notFound();
  const latest = await deps.documents.latestRequest(id);
  if (latest && latest.status === 'pending' && effectiveStatus(latest, deps.clock.now()) === 'expired') {
    await deps.documents.expireRequest(latest.id, deps.clock.now());
    document = (await deps.documents.findById(id)) ?? document;
  }
  return document;
}

/**
 * Demande de signature par un service métier (ADR-044). Le signataire est un compte KSP (ses
 * coordonnées sont lues dans identity à chaque envoi) ou une personne sans compte, identifiée par
 * son téléphone : elle reçoit un lien personnel (jeton aléatoire dont seule l'empreinte est gardée).
 * Le signataire est prévenu aussitôt ; si le message ne part pas, la demande est retirée et
 * l'erreur renvoyée (le service réessaie avec la même clé). Idempotente par la clé.
 */
export class RequestSignatureUseCase {
  private readonly codes: SignatureCodes;

  constructor(private readonly deps: DocumentDeps) {
    this.codes = new SignatureCodes(deps);
  }

  async execute(input: RequestSignatureInput): Promise<{ view: DocumentView; signature: SignatureView }> {
    const { settings, documents, clock, ids, secrets, users, notifier } = this.deps;
    const caller = requireInternalCaller(settings.internalCallers);
    const document = await loadOwnDocument(this.deps, caller, input.documentId);
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);

    const replayed = await documents.findRequestByIdempotencyKey(document.id, idempotencyKey);
    if (replayed) return this.result(document.id, replayed);

    const template = findTemplate(document.template, document.templateVersion);
    if (template?.info.signature === 'none') throw DocumentErrors.signatureNotRequired();
    if (!canRequestSignature(document.status)) throw DocumentErrors.invalidStatus(document.status);

    const hours = input.expiresInHours || DEFAULT_REQUEST_HOURS;
    if (!Number.isInteger(hours) || hours < 1 || hours > MAX_REQUEST_HOURS) {
      throw DocumentErrors.invalid('expiresInHours', `Entre 1 et ${MAX_REQUEST_HOURS} heures.`);
    }
    const notice = input.notice || 'invitation';
    if (notice !== 'invitation' && notice !== 'code') throw DocumentErrors.invalid('notice');

    // Signataire : compte KSP, ou personne sans compte identifiée par son téléphone.
    const signer = input.signer ?? {};
    const userId = signer.userId ? requireUuid('signer.userId', signer.userId) : null;
    let name: string;
    let contact: Contact;
    let firstName: string;
    if (userId) {
      const account = await users.find(userId);
      if (!account) throw DocumentErrors.invalid('signer.userId', 'Compte du signataire introuvable.');
      firstName = account.firstName;
      name = (signer.displayName ?? '').trim() || `${account.firstName} ${account.lastName}`.trim();
      contact = { userId, phoneE164: account.phoneE164, email: account.email };
    } else {
      const phone = parsePhone(signer.phoneE164);
      if (!phone) throw DocumentErrors.invalid('signer.phoneE164', 'Numéro E.164 attendu.');
      name = (signer.displayName ?? '').trim();
      firstName = name.split(' ')[0] ?? '';
      const email = signer.email ? parseEmail(signer.email) : null;
      if (signer.email && !email) throw DocumentErrors.invalid('signer.email', 'Adresse e-mail invalide.');
      contact = { userId: null, phoneE164: phone, email };
    }
    if (!name || name.length > 200 || hasControlCharacter(name))
      throw DocumentErrors.invalid('signer.displayName', 'Nom du signataire obligatoire.');
    if (!contact.phoneE164 && !contact.email) throw DocumentErrors.signerUnreachable();
    if (notice === 'code' && !userId) {
      throw DocumentErrors.invalid('notice', 'Le code immédiat est réservé à un signataire connecté.');
    }

    const now = clock.now();
    const token = userId ? null : secrets.newToken();
    const request: SignatureRequestRecord = {
      id: ids.next(),
      documentId: document.id,
      status: 'pending',
      signerUserId: userId,
      // Coordonnées d'un compte : relues dans identity à chaque envoi, jamais copiées ici.
      signerPhoneE164: userId ? null : contact.phoneE164,
      signerEmail: userId ? null : contact.email,
      signerPhoneMasked: contact.phoneE164 ? maskPhone(contact.phoneE164) : '',
      signerName: name,
      tokenHash: token ? secrets.hashToken(token) : null,
      documentSha256: document.sha256,
      idempotencyKey,
      createdAt: now,
      expiresAt: new Date(now.getTime() + hours * 3_600_000),
      signedAt: null,
      closedAt: null,
    };
    const previous: DocumentStatus = document.status;
    if (!(await documents.openRequest(request, ['draft', 'expired']))) {
      // Demande simultanée avec la même clé : la sienne fait foi.
      const concurrent = await documents.findRequestByIdempotencyKey(document.id, idempotencyKey);
      if (concurrent) return this.result(document.id, concurrent);
      const current = await documents.findById(document.id);
      throw DocumentErrors.invalidStatus(current?.status ?? document.status);
    }

    try {
      if (notice === 'code') {
        await this.codes.send({ ...document, status: 'pending_signature' }, request, contact);
      } else {
        await notifier.sendInvitation({
          requestId: request.id,
          contact,
          firstName,
          documentTitle: document.title,
          link: token
            ? signingLink(settings.portalBaseUrl, token)
            : accountSigningLink(settings.portalBaseUrl, document.id),
          expiresOn: formatLongDate(request.expiresAt, settings.timeZone),
        });
      }
    } catch (error) {
      await documents.abortRequest(request.id, document.id, previous);
      throw error;
    }
    return this.result(document.id, request);
  }

  private async result(documentId: string, request: SignatureRequestRecord) {
    const document = await this.deps.documents.findById(documentId);
    if (!document) throw DocumentErrors.notFound();
    const view = await viewOf(this.deps, document);
    return { view, signature: await signatureViewOf(this.deps, request, this.deps.clock.now()) };
  }
}

/**
 * Annulation d'un document non signé par son service (ADR-044) : la demande en attente est close et
 * le lien ne sert plus. Idempotente ; un document signé ne s'annule pas (preuve).
 */
export class CancelDocumentUseCase {
  constructor(private readonly deps: DocumentDeps) {}

  async execute(input: { documentId?: string; reason?: string }): Promise<DocumentView> {
    const caller = requireInternalCaller(this.deps.settings.internalCallers);
    const document = await loadOwnDocument(this.deps, caller, input.documentId);
    const reason = (input.reason ?? '').trim();
    if (reason.length > 500) throw DocumentErrors.invalid('reason', '500 caractères au plus.');
    if (document.status === 'cancelled') return viewOf(this.deps, document);
    if (!canCancel(document.status)) throw DocumentErrors.invalidStatus(document.status);
    const now = this.deps.clock.now();
    if (!(await this.deps.documents.cancelDocument(document.id, { reason: reason || null, now }))) {
      const current = await this.deps.documents.findById(document.id);
      throw DocumentErrors.invalidStatus(current?.status ?? 'signed');
    }
    const cancelled: DocumentRecord = {
      ...document,
      status: 'cancelled',
      cancelledAt: now,
      cancellationReason: reason || null,
    };
    return viewOf(this.deps, cancelled);
  }
}

/** Adresse de lecture remise par le service métier à un utilisateur qu'il a autorisé. */
export class CreateDownloadUrlUseCase {
  constructor(private readonly deps: DocumentDeps) {}

  async execute(input: { documentId?: string; version?: string }) {
    const caller = requireInternalCaller(this.deps.settings.internalCallers);
    const id = requireUuid('documentId', input.documentId);
    const document = await this.deps.documents.findById(id);
    if (!document || !ownsDocument(document, caller)) throw DocumentErrors.notFound();
    const version = input.version || 'current';
    if (version !== 'current' && version !== 'original' && version !== 'signed') {
      throw DocumentErrors.invalid('version');
    }
    if (version === 'signed' && !document.signedFileId) throw DocumentErrors.invalidStatus(document.status);
    const signed = version === 'signed' || (version === 'current' && document.signedFileId !== null);
    return downloadOf(this.deps, document, signed);
  }
}

/** Adresse de lecture du PDF d'origine ou signé. */
export async function downloadOf(deps: DocumentDeps, document: DocumentRecord, signed: boolean) {
  const fileId = signed && document.signedFileId ? document.signedFileId : document.fileId;
  const link = await deps.pdfs.downloadUrl(fileId, document.id);
  return { ...link, version: fileId === document.fileId ? ('original' as const) : ('signed' as const) };
}
