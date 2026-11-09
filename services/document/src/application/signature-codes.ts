import { decideSend } from '../domain/code-policy';
import { type DocumentRecord } from '../domain/document';
import { effectiveStatus, type CodeChannel, type SignatureRequestRecord } from '../domain/signature';
import { DocumentErrors } from './errors';
import { type Contact, type DocumentDeps } from './ports';

export interface CodeDelivery {
  channel: CodeChannel;
  expiresAt: Date;
  resendAfterSeconds: number;
}

const HOUR_MS = 3_600_000;

/**
 * Envoi d'un code de signature (ADR-044) : demande en attente, limites d'envoi respectées (un code
 * toutes les 60 secondes, 5 par heure), code tiré au hasard dont seule l'empreinte HMAC est
 * gardée, envoyé par notification (WhatsApp, e-mail en repli). Un code non parti est retiré.
 */
export class SignatureCodes {
  constructor(private readonly deps: DocumentDeps) {}

  /** Coordonnées à jour : celles d'un compte sont relues dans identity. */
  async contactOf(request: SignatureRequestRecord): Promise<Contact> {
    if (!request.signerUserId) {
      return { userId: null, phoneE164: request.signerPhoneE164, email: request.signerEmail };
    }
    const account = await this.deps.users.find(request.signerUserId);
    if (!account) throw DocumentErrors.signerUnreachable();
    return { userId: request.signerUserId, phoneE164: account.phoneE164, email: account.email };
  }

  async send(
    document: DocumentRecord,
    request: SignatureRequestRecord,
    contact?: Contact,
  ): Promise<CodeDelivery> {
    const { documents, clock, ids, secrets, notifier, settings } = this.deps;
    const policy = settings.codePolicy;
    const now = clock.now();
    const status = effectiveStatus(request, now);
    if (status !== 'pending') {
      if (status === 'expired' && request.status === 'pending')
        await documents.expireRequest(request.id, now);
      throw DocumentErrors.signatureClosed(status);
    }
    if (document.status !== 'pending_signature') throw DocumentErrors.invalidStatus(document.status);

    const decision = decideSend(
      await documents.codeSentDates(request.id, new Date(now.getTime() - HOUR_MS)),
      now,
      policy,
    );
    if (!decision.allowed) {
      throw decision.reason === 'too_soon'
        ? DocumentErrors.codeTooSoon(decision.retryAfterSeconds)
        : DocumentErrors.codeLimitReached(decision.retryAfterSeconds);
    }
    const to = contact ?? (await this.contactOf(request));
    if (!to.phoneE164 && !to.email) throw DocumentErrors.signerUnreachable();

    const id = ids.next();
    const code = secrets.newCode(policy.length);
    const expiresAt = new Date(now.getTime() + policy.ttlSeconds * 1000);
    await documents.createCode({
      id,
      requestId: request.id,
      codeHash: secrets.hashCode(id, code),
      channel: to.phoneE164 ? 'whatsapp' : 'email',
      createdAt: now,
      expiresAt,
      attempts: 0,
      consumedAt: null,
    });
    try {
      const { channel } = await notifier.sendCode({
        codeId: id,
        contact: to,
        code,
        expiresInMinutes: Math.ceil(policy.ttlSeconds / 60),
        documentTitle: document.title,
        ttlSeconds: policy.ttlSeconds,
      });
      await documents.setCodeChannel(id, channel);
      return { channel, expiresAt, resendAfterSeconds: policy.resendDelaySeconds };
    } catch (error) {
      // Code jamais reçu : il ne compte ni dans les limites ni comme code valable.
      await documents.deleteCode(id).catch(() => undefined);
      throw error;
    }
  }
}
