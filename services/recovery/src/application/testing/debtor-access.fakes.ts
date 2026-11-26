import { createHash, createHmac } from 'node:crypto';
import {
  type CaseDebtor,
  type DebtorAccessChange,
  type DebtorAccessEvent,
  type DebtorAccessJournal,
  type DebtorAccessStore,
  type DebtorCaseReader,
  type DebtorSecrets,
  type EncryptedContact,
  type NewDebtorAccess,
  type StoredDebtorAccess,
  type StoredDebtorSession,
} from '../debtor-access/debtor-access.ports';
import { type Notifier } from '../ports';

/** Doublures en mémoire de l'accès du débiteur (tests des cas d'usage). */

interface MemorySession {
  id: string;
  accessId: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

/** Liens et sessions : comme en base, seules les empreintes des jetons sont gardées. */
export class MemoryDebtorAccessStore implements DebtorAccessStore {
  readonly rows = new Map<string, { tokenHash: string; access: StoredDebtorAccess }>();
  readonly sessions = new Map<string, MemorySession>();

  async findByTokenHash(tokenHash: string): Promise<StoredDebtorAccess | null> {
    const row = [...this.rows.values()].find((candidate) => candidate.tokenHash === tokenHash);
    return row ? structuredClone(row.access) : null;
  }

  async issue(access: NewDebtorAccess): Promise<{ replaced: number }> {
    const replaced = await this.revoke(
      { caseId: access.caseId, debtorId: access.debtorId },
      access.link.issuedAt,
    );
    this.rows.set(access.id, {
      tokenHash: access.tokenHash,
      access: {
        id: access.id,
        caseId: access.caseId,
        debtorId: access.debtorId,
        link: { ...access.link },
        code: null,
        codeSentAt: null,
        codesSent: 0,
        attempts: { failures: 0, lockedUntil: null },
      },
    });
    return { replaced };
  }

  async revoke(scope: { caseId: string; debtorId?: string }, at: Date): Promise<number> {
    let revoked = 0;
    for (const { access } of this.rows.values()) {
      if (access.caseId !== scope.caseId || access.link.revokedAt !== null) continue;
      if (scope.debtorId && access.debtorId !== scope.debtorId) continue;
      access.link.revokedAt = at;
      for (const session of this.sessions.values()) {
        if (session.accessId === access.id && session.revokedAt === null) session.revokedAt = at;
      }
      revoked += 1;
    }
    return revoked;
  }

  async restrict(scope: { caseId: string }, until: Date, at: Date): Promise<number> {
    let restricted = 0;
    for (const { access } of this.rows.values()) {
      if (access.caseId !== scope.caseId || access.link.revokedAt !== null || access.link.expiresAt <= at) {
        continue;
      }
      access.link.expiresAt = until;
      restricted += 1;
    }
    return restricted;
  }

  async updateLocked<T>(
    accessId: string,
    decide: (access: StoredDebtorAccess) => { change: DebtorAccessChange | null; result: T },
  ): Promise<T | null> {
    const row = this.rows.get(accessId);
    if (!row) return null;
    const { change, result } = decide(structuredClone(row.access));
    if (change) this.apply(row.access, change);
    return result;
  }

  async findSession(tokenHash: string): Promise<StoredDebtorSession | null> {
    const session = [...this.sessions.values()].find((candidate) => candidate.tokenHash === tokenHash);
    if (!session) return null;
    const { access } = this.rows.get(session.accessId)!;
    return {
      id: session.id,
      accessId: session.accessId,
      caseId: access.caseId,
      debtorId: access.debtorId,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
      accessRevokedAt: access.link.revokedAt,
    };
  }

  async endSession(sessionId: string, at: Date): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.revokedAt !== null) return false;
    session.revokedAt = at;
    return true;
  }

  /** Seul lien du débiteur encore actif (au plus un). */
  activeOf(debtorId: string): StoredDebtorAccess | undefined {
    return [...this.rows.values()]
      .map((row) => row.access)
      .find((access) => access.debtorId === debtorId && access.link.revokedAt === null);
  }

  private apply(access: StoredDebtorAccess, change: DebtorAccessChange): void {
    if (change.code !== undefined) access.code = change.code ? { ...change.code } : null;
    if (change.codeSentAt !== undefined) access.codeSentAt = change.codeSentAt;
    if (change.countCodeSent) access.codesSent += 1;
    if (change.attempts) access.attempts = { ...change.attempts };
    if (change.session) {
      this.sessions.set(change.session.id, { ...change.session, accessId: access.id, revokedAt: null });
    }
  }
}

/** Débiteurs des dossiers et leurs coordonnées chiffrées (FakePersonalData). */
export class MemoryDebtorCaseReader implements DebtorCaseReader {
  readonly debtors = new Map<
    string,
    { caseId: string; caseDebtor: CaseDebtor; contacts: EncryptedContact[] }
  >();

  add(caseId: string, debtorId: string, caseDebtor: CaseDebtor, contacts: EncryptedContact[]): void {
    this.debtors.set(debtorId, { caseId, caseDebtor, contacts });
  }

  async caseDebtor(caseId: string, debtorId: string): Promise<CaseDebtor | null> {
    const debtor = this.debtors.get(debtorId);
    return debtor && debtor.caseId === caseId ? structuredClone(debtor.caseDebtor) : null;
  }

  async contacts(debtorId: string): Promise<EncryptedContact[]> {
    return [...(this.debtors.get(debtorId)?.contacts ?? [])];
  }
}

export class MemoryDebtorAccessJournal implements DebtorAccessJournal {
  readonly events: DebtorAccessEvent[] = [];
  async record(event: DebtorAccessEvent): Promise<void> {
    this.events.push(event);
  }
}

/**
 * Secrets des tests : jetons tirés à la suite (43 caractères base64url), codes fournis par
 * `nextCodes` ou tirés à la suite, empreintes calculées comme en production (SHA-256, HMAC avec une
 * clé de test). Compte les comparaisons de codes (ADR-050).
 */
export class FakeDebtorSecrets implements DebtorSecrets {
  readonly nextCodes: string[] = [];
  comparisons = 0;
  private tokens = 0;
  private codes = 0;

  newToken(): string {
    this.tokens += 1;
    return createHash('sha256').update(`jeton-${this.tokens}`).digest('base64url');
  }
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
  newCode(): string {
    this.codes += 1;
    return this.nextCodes.shift() ?? String(100_000 + this.codes);
  }
  hashCode(accessId: string, code: string): string {
    return createHmac('sha256', 'cle-de-test').update(`${accessId}:${code}`).digest('hex');
  }
  codeMatches(accessId: string, code: string, hash: string): boolean {
    this.comparisons += 1;
    return this.hashCode(accessId, code) === hash;
  }
}

export function memoryDebtorAccess(baseUrl = 'https://ksp.bj/recouvrement') {
  return {
    store: new MemoryDebtorAccessStore(),
    reader: new MemoryDebtorCaseReader(),
    journal: new MemoryDebtorAccessJournal(),
    secrets: new FakeDebtorSecrets(),
    baseUrl,
  };
}

/** Notification factice : garde les messages au débiteur, ou échoue comme demandé. */
export class CapturingNotifier implements Notifier {
  readonly sent: Parameters<Notifier['sendToDebtor']>[0][] = [];
  failure: Error | null = null;

  async sendToDebtor(input: Parameters<Notifier['sendToDebtor']>[0]) {
    if (this.failure) throw this.failure;
    this.sent.push(input);
    return { notificationId: `n-${this.sent.length}`, status: 'accepted' };
  }

  /** Dernier code envoyé (variable `code` du modèle). */
  lastCode(): string {
    return this.sent.at(-1)?.variables['code'] ?? '';
  }
}
