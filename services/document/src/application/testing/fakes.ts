import { createHash } from 'node:crypto';
import { DEFAULT_CODE_POLICY, type SendDecision } from '../../domain/code-policy';
import { type DocumentContent } from '../../domain/content';
import { type DocumentRecord, type DocumentStatus } from '../../domain/document';
import { type CodeChannel, type SignatureCode, type SignatureRequestRecord } from '../../domain/signature';
import { DocumentErrors } from '../errors';
import {
  type AccountErasure,
  type Clock,
  type CodeAttempt,
  type Contact,
  type DocumentDeps,
  type DocumentRepository,
  type DocumentSettings,
  type IdGenerator,
  type PdfRenderer,
  type PdfStore,
  type SecretTools,
  type SignatureCompletion,
  type SignatureNotifier,
  type UserDirectory,
} from '../ports';

/** Doublures en mémoire des ports, pour les tests des cas d'usage. */
export class FakeClock implements Clock {
  constructor(public current = new Date('2026-11-09T10:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class SequentialIds implements IdGenerator {
  private n = 0;
  next(): string {
    this.n += 1;
    return `0192f1c4-0000-7000-8000-${String(this.n).padStart(12, '0')}`;
  }
}

export class InMemoryDocuments implements DocumentRepository {
  documents = new Map<string, DocumentRecord>();
  requests = new Map<string, SignatureRequestRecord>();
  codes = new Map<string, SignatureCode>();
  completions: SignatureCompletion[] = [];
  counters = new Map<string, number>();
  processed = new Set<string>();
  /** Essais pris par demande, tous codes confondus. */
  requestAttempts = new Map<string, number>();

  async nextNumber(prefix: string, year: number): Promise<number> {
    const key = `${prefix}:${year}`;
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }
  async create(document: DocumentRecord): Promise<boolean> {
    const taken = [...this.documents.values()].some(
      (d) => d.producerService === document.producerService && d.idempotencyKey === document.idempotencyKey,
    );
    if (taken) return false;
    this.documents.set(document.id, { ...document });
    return true;
  }
  async findById(id: string) {
    const found = this.documents.get(id);
    return found ? { ...found } : null;
  }
  async findByIdempotencyKey(producerService: string, key: string) {
    const found = [...this.documents.values()].find(
      (d) => d.producerService === producerService && d.idempotencyKey === key,
    );
    return found ? { ...found } : null;
  }
  async findRequestById(id: string) {
    const found = this.requests.get(id);
    return found ? { ...found } : null;
  }
  async findRequestByTokenHash(tokenHash: string) {
    const found = [...this.requests.values()].find((r) => r.tokenHash === tokenHash);
    return found ? { ...found } : null;
  }
  async findRequestByIdempotencyKey(documentId: string, key: string) {
    const found = [...this.requests.values()].find(
      (r) => r.documentId === documentId && r.idempotencyKey === key,
    );
    return found ? { ...found } : null;
  }
  async latestRequest(documentId: string) {
    const all = [...this.requests.values()].filter((r) => r.documentId === documentId);
    const found = all.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
    )[0];
    return found ? { ...found } : null;
  }
  async isSigner(documentId: string, userId: string) {
    return [...this.requests.values()].some((r) => r.documentId === documentId && r.signerUserId === userId);
  }
  async openRequest(request: SignatureRequestRecord, expected: readonly DocumentStatus[]) {
    const document = this.documents.get(request.documentId);
    if (!document || !expected.includes(document.status)) return false;
    document.status = 'pending_signature';
    this.requests.set(request.id, { ...request });
    return true;
  }
  async abortRequest(requestId: string, documentId: string, restore: DocumentStatus) {
    this.requests.delete(requestId);
    const document = this.documents.get(documentId);
    if (document?.status === 'pending_signature') document.status = restore;
  }
  async cancelDocument(id: string, input: { reason: string | null; now: Date }) {
    const document = this.documents.get(id);
    if (!document || document.status === 'signed' || document.status === 'cancelled') return false;
    Object.assign(document, {
      status: 'cancelled',
      cancelledAt: input.now,
      cancellationReason: input.reason,
    });
    for (const request of this.requests.values()) {
      if (request.documentId === id && request.status === 'pending')
        this.close(request, 'cancelled', input.now);
    }
    return true;
  }
  async expireRequest(requestId: string, now: Date) {
    const request = this.requests.get(requestId);
    if (!request || request.status !== 'pending' || request.expiresAt > now) return false;
    this.close(request, 'expired', now);
    const document = this.documents.get(request.documentId);
    if (document?.status === 'pending_signature') document.status = 'expired';
    return true;
  }
  async expireDue(now: Date, limit: number) {
    const due = [...this.requests.values()]
      .filter((r) => r.status === 'pending' && r.expiresAt <= now)
      .slice(0, limit);
    for (const request of due) await this.expireRequest(request.id, now);
    return due.length;
  }
  async createCodeWithinLimits(
    code: SignatureCode,
    since: Date,
    decide: (sentAt: Date[]) => SendDecision,
  ): Promise<SendDecision | null> {
    if (this.requests.get(code.requestId)?.status !== 'pending') return null;
    const decision = decide(
      [...this.codes.values()]
        .filter((c) => c.requestId === code.requestId && c.createdAt >= since)
        .map((c) => c.createdAt),
    );
    if (decision.allowed) this.codes.set(code.id, { ...code });
    return decision;
  }
  async setCodeChannel(codeId: string, channel: CodeChannel) {
    const code = this.codes.get(codeId);
    if (code) code.channel = channel;
  }
  async deleteCode(codeId: string) {
    this.codes.delete(codeId);
  }
  async activeCode(requestId: string, now: Date, maxAttempts: number) {
    const latest = [...this.codes.values()]
      .filter((c) => c.requestId === requestId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))[0];
    if (!latest || latest.consumedAt || latest.expiresAt <= now || latest.attempts >= maxAttempts)
      return null;
    return { ...latest };
  }
  async takeCodeAttempt(
    requestId: string,
    now: Date,
    limits: { perCode: number; perRequest: number },
  ): Promise<CodeAttempt> {
    const request = this.requests.get(requestId);
    if (request?.status !== 'pending') return { kind: 'closed' };
    const used = this.requestAttempts.get(requestId) ?? 0;
    if (used >= limits.perRequest) return { kind: 'request_exhausted' };
    const active = await this.activeCode(requestId, now, limits.perCode);
    if (!active) return { kind: 'no_code' };
    const code = this.codes.get(active.id)!;
    code.attempts += 1;
    this.requestAttempts.set(requestId, used + 1);
    return { kind: 'taken', code: { ...code }, requestAttempts: used + 1 };
  }
  async closeExhaustedRequest(requestId: string, now: Date) {
    const request = this.requests.get(requestId);
    if (request?.status !== 'pending') return false;
    this.close(request, 'expired', now);
    const document = this.documents.get(request.documentId);
    if (document?.status === 'pending_signature') document.status = 'expired';
    return true;
  }
  async completeSignature(completion: SignatureCompletion) {
    const code = this.codes.get(completion.codeId);
    const request = this.requests.get(completion.requestId);
    const document = this.documents.get(completion.documentId);
    if (
      !code ||
      code.consumedAt ||
      request?.status !== 'pending' ||
      document?.status !== 'pending_signature'
    ) {
      return false;
    }
    code.consumedAt = completion.signedAt;
    this.close(request, 'signed', completion.signedAt);
    request.signedAt = completion.signedAt;
    Object.assign(document, {
      status: 'signed',
      signedAt: completion.signedAt,
      signedFileId: completion.signedFileId,
      signedSha256: completion.signedSha256,
    });
    this.completions.push(completion);
    return true;
  }
  async eraseAccount(
    userId: string,
    input: { eventId: string; consumer: string; now: Date },
  ): Promise<AccountErasure> {
    const key = `${input.eventId}:${input.consumer}`;
    if (this.processed.has(key)) return { status: 'duplicate', detachedDocuments: 0, cancelledRequests: 0 };
    this.processed.add(key);
    let cancelledRequests = 0;
    for (const request of this.requests.values()) {
      if (request.signerUserId !== userId) continue;
      if (request.status === 'pending') {
        this.close(request, 'cancelled', input.now);
        cancelledRequests += 1;
        const document = this.documents.get(request.documentId);
        if (document?.status === 'pending_signature') document.status = 'draft';
      }
      request.signerUserId = null;
    }
    let detachedDocuments = 0;
    for (const document of this.documents.values()) {
      if (document.ownerId === userId) {
        document.ownerId = null;
        detachedDocuments += 1;
      }
    }
    return { status: 'processed', detachedDocuments, cancelledRequests };
  }

  private close(request: SignatureRequestRecord, status: 'signed' | 'expired' | 'cancelled', now: Date) {
    Object.assign(request, { status, closedAt: now, signerPhoneE164: null, signerEmail: null });
  }
}

/** Rendu factice : le « PDF » est le texte du contenu, pages séparées par un saut de page. */
export class FakeRenderer implements PdfRenderer {
  rendered: DocumentContent[] = [];
  async render(content: DocumentContent): Promise<Uint8Array> {
    this.rendered.push(content);
    return new TextEncoder().encode(`PDF:${content.title}:${content.number}`);
  }
  async pageCount(pdf: Uint8Array): Promise<number> {
    return new TextDecoder().decode(pdf).split('\f').length;
  }
  async appendCertificate(original: Uint8Array, certificate: DocumentContent): Promise<Uint8Array> {
    this.rendered.push(certificate);
    return new TextEncoder().encode(`${new TextDecoder().decode(original)}\fCERT:${certificate.number}`);
  }
}

export class InMemoryPdfStore implements PdfStore {
  files = new Map<
    string,
    { documentId: string; bytes: Uint8Array; ownerId: string | null; fileName: string }
  >();
  removed: string[] = [];
  failNextStore = false;
  private n = 0;
  async store(input: { documentId: string; fileName: string; bytes: Uint8Array; ownerId: string | null }) {
    if (this.failNextStore) {
      this.failNextStore = false;
      throw DocumentErrors.dependencyUnavailable('file');
    }
    this.n += 1;
    const fileId = `0192f1c4-0000-7000-9000-${String(this.n).padStart(12, '0')}`;
    this.files.set(fileId, { ...input });
    return { fileId };
  }
  async read(fileId: string) {
    return this.files.get(fileId)!.bytes;
  }
  async downloadUrl(fileId: string) {
    return { url: `https://stockage.test/${fileId}`, expiresAt: new Date('2026-11-09T10:05:00.000Z') };
  }
  async remove(fileId: string) {
    this.removed.push(fileId);
    this.files.delete(fileId);
  }
}

export class RecordingNotifier implements SignatureNotifier {
  codes: { codeId: string; contact: Contact; code: string; documentTitle: string }[] = [];
  invitations: { requestId: string; contact: Contact; firstName: string; link: string; expiresOn: string }[] =
    [];
  fail: Error | null = null;
  async sendCode(input: Parameters<SignatureNotifier['sendCode']>[0]) {
    if (this.fail) throw this.fail;
    this.codes.push(input);
    return { channel: (input.contact.phoneE164 ? 'whatsapp' : 'email') as CodeChannel };
  }
  async sendInvitation(input: Parameters<SignatureNotifier['sendInvitation']>[0]) {
    if (this.fail) throw this.fail;
    this.invitations.push(input);
    return { channel: (input.contact.phoneE164 ? 'whatsapp' : 'email') as CodeChannel };
  }
}

export class InMemoryUsers implements UserDirectory {
  users = new Map<
    string,
    { firstName: string; lastName: string; phoneE164: string | null; email: string | null }
  >();
  async find(userId: string) {
    return this.users.get(userId) ?? null;
  }
}

/** Secrets prévisibles : codes tirés d'une file, empreintes SHA-256 sans clé. */
export class FakeSecrets implements SecretTools {
  nextCodes: string[] = [];
  private tokens = 0;
  sha256(bytes: Uint8Array) {
    return createHash('sha256').update(bytes).digest('hex');
  }
  newCode(length: number) {
    return this.nextCodes.shift() ?? '1'.repeat(length);
  }
  hashCode(codeId: string, code: string) {
    return createHash('sha256').update(`${codeId}:${code}`).digest('hex');
  }
  codeMatches(codeId: string, code: string, codeHash: string) {
    return this.hashCode(codeId, code) === codeHash;
  }
  newToken() {
    this.tokens += 1;
    return `${'t'.repeat(40)}${String(this.tokens).padStart(3, '0')}`;
  }
  hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }
}

export const TEST_SETTINGS: DocumentSettings = {
  issuer: { name: 'Groupe KSP', address: 'Cotonou, Bénin', legalDetails: '' },
  timeZone: 'Africa/Porto-Novo',
  codePolicy: DEFAULT_CODE_POLICY,
  portalBaseUrl: 'https://ksp.bj',
  genericTemplateEnabled: true,
  internalCallers: ['recovery', 'cleaning', 'billing'],
  signedLinkDays: 7,
};

export function fakeDeps() {
  const deps = {
    documents: new InMemoryDocuments(),
    renderer: new FakeRenderer(),
    pdfs: new InMemoryPdfStore(),
    notifier: new RecordingNotifier(),
    users: new InMemoryUsers(),
    secrets: new FakeSecrets(),
    settings: TEST_SETTINGS,
    clock: new FakeClock(),
    ids: new SequentialIds(),
  };
  return deps satisfies DocumentDeps;
}
