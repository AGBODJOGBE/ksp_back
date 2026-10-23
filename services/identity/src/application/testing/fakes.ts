/**
 * Doublures en mémoire des ports de l'application, pour les tests des cas d'usage.
 * Elles reproduisent les garanties des vrais dépôts (atomicité, unicité) sans base de données.
 */
import { type OtpChallenge, type OtpChannel } from '../../domain/otp/otp-challenge';
import { clientKindsOf, sessionCategory } from '../../domain/session/session-policy';
import { type StoredOtpChallenge } from '../../domain/otp/otp-verification';
import { type PhoneNumber } from '../../domain/user/phone-number';
import { type OtpChallengeRepository, type OtpRequestedEvent } from '../otp/otp.ports';
import {
  type RefreshRotation,
  type SessionStore,
  type StoredRefreshToken,
} from '../session/session-store.ports';
import {
  type Account,
  type AccountRepository,
  ChallengeAlreadyConsumedError,
  type FailedLogin,
  type LoginRepository,
  type PhoneLoginPlan,
  type ProfileChanges,
} from '../session/session.ports';

type ChallengeRow = OtpChallenge & {
  sentAt?: Date;
  channelUsed?: OtpChannel;
  sendFailedAt?: Date;
  consumedAt?: Date;
};

export class InMemoryChallenges implements OtpChallengeRepository {
  readonly rows = new Map<string, ChallengeRow>();
  readonly events: OtpRequestedEvent[] = [];

  async sentAtSince(target: PhoneNumber, since: Date): Promise<Date[]> {
    return [...this.rows.values()]
      .filter((row) => row.target.e164 === target.e164 && row.sentAt && row.sentAt >= since)
      .map((row) => row.sentAt as Date);
  }
  async create(challenge: OtpChallenge): Promise<void> {
    this.rows.set(challenge.id, { ...challenge });
  }
  async markSent(id: string, channelUsed: OtpChannel, sentAt: Date, event: OtpRequestedEvent): Promise<void> {
    Object.assign(this.rows.get(id)!, { channelUsed, sentAt });
    this.events.push(event);
  }
  async markSendFailed(id: string, failedAt: Date): Promise<void> {
    Object.assign(this.rows.get(id)!, { sendFailedAt: failedAt });
  }
  async findById(id: string): Promise<StoredOtpChallenge | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    return {
      id: row.id,
      target: row.target.e164,
      codeHash: row.codeHash,
      attempts: row.attempts,
      expiresAt: row.expiresAt,
      sentAt: row.sentAt ?? null,
      sendFailedAt: row.sendFailedAt ?? null,
      consumedAt: row.consumedAt ?? null,
    };
  }
  async registerFailedAttempt(id: string): Promise<number> {
    const row = this.rows.get(id)!;
    row.attempts += 1;
    return row.attempts;
  }
}

export interface StoredSession {
  id: string;
  userId: string;
  clientKind: 'web' | 'mobile' | 'backoffice';
  deviceLabel?: string | null;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
  revokeReason?: string;
  refreshTokenHash: string;
  mfaAt?: Date;
}

export interface FakeLoginEvent {
  userId: string | null;
  success: boolean;
  reason?: string;
  method?: string;
}

/** Comptes, sessions et historique en mémoire ; partage la table des demandes pour les consommer. */
export class InMemoryIdentityStore implements AccountRepository, LoginRepository {
  readonly accounts: Account[] = [];
  readonly sessions: StoredSession[] = [];
  readonly loginEvents: FakeLoginEvent[] = [];
  readonly registered: string[] = [];

  constructor(private readonly challenges: InMemoryChallenges) {}

  async findByPhone(phoneE164: string): Promise<Account | null> {
    return this.accounts.find((account) => account.phoneE164 === phoneE164) ?? null;
  }

  async findById(userId: string): Promise<Account | null> {
    return this.accounts.find((account) => account.id === userId) ?? null;
  }

  async findByIds(userIds: readonly string[]): Promise<Account[]> {
    return this.accounts.filter((account) => userIds.includes(account.id));
  }

  async updateProfile(userId: string, changes: ProfileChanges): Promise<Account | null> {
    const account = this.accounts.find((candidate) => candidate.id === userId);
    if (!account) return null;
    Object.assign(account, changes);
    return account;
  }

  async completePhoneLogin(plan: PhoneLoginPlan): Promise<{ account: Account; isNewUser: boolean }> {
    const challenge = this.challenges.rows.get(plan.challengeId)!;
    if (challenge.consumedAt) throw new ChallengeAlreadyConsumedError();
    challenge.consumedAt = plan.now;

    let account = this.accounts.find((candidate) => candidate.id === plan.existingUserId);
    const isNewUser = !account;
    if (!account) {
      account = {
        id: plan.newUserId,
        status: 'active',
        firstName: null,
        lastName: null,
        phoneE164: plan.phoneE164,
        email: null,
        preferredLanguage: 'fr',
        createdAt: plan.now,
      };
      this.accounts.push(account);
      this.registered.push(account.id);
    }

    this.applySessionLimit(account.id, plan.session.clientKind, plan.maxSessions, plan.now);
    this.sessions.push({
      id: plan.session.id,
      userId: account.id,
      clientKind: plan.session.clientKind,
      lastSeenAt: plan.now,
      expiresAt: plan.session.expiresAt,
      refreshTokenHash: plan.refreshToken.hash,
    });
    this.loginEvents.push({ userId: account.id, success: true });
    return { account, isNewUser };
  }

  async recordFailedLogin(event: FailedLogin): Promise<void> {
    this.loginEvents.push({
      userId: event.userId,
      success: false,
      reason: event.reason,
      ...(event.method ? { method: event.method } : {}),
    });
  }

  /** Révoque les sessions de la même catégorie au-delà de la limite, les moins récentes d'abord. */
  applySessionLimit(userId: string, clientKind: StoredSession['clientKind'], max: number, now: Date): void {
    const kinds = clientKindsOf(sessionCategory(clientKind));
    const active = this.sessions
      .filter(
        (session) => session.userId === userId && !session.revokedAt && kinds.includes(session.clientKind),
      )
      .sort((a, b) => a.lastSeenAt.getTime() - b.lastSeenAt.getTime());
    for (const session of active.slice(0, Math.max(0, active.length + 1 - max))) {
      session.revokedAt = now;
      session.revokeReason = 'session_limit';
    }
  }
}

interface FakeRefreshToken {
  id: string;
  hash: string;
  sessionId: string;
  usedAt: Date | null;
  replacedById?: string;
}

interface FakeSession {
  id: string;
  userId: string;
  clientKind: 'web' | 'mobile' | 'backoffice';
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokeReason?: string;
  mfaAt?: Date | null;
}

/** Sessions et jetons de renouvellement en mémoire, avec la même atomicité que le vrai dépôt. */
export class InMemorySessionStore implements SessionStore {
  readonly sessions: FakeSession[] = [];
  readonly tokens: FakeRefreshToken[] = [];
  readonly accounts = new Map<string, Account>();
  /** Simule un autre renouvellement qui passe juste avant (course entre deux requêtes). */
  raceOnNextRotation = false;

  async findRefreshToken(hash: string): Promise<StoredRefreshToken | null> {
    const token = this.tokens.find((candidate) => candidate.hash === hash);
    if (!token) return null;
    const session = this.sessions.find((candidate) => candidate.id === token.sessionId)!;
    return {
      id: token.id,
      usedAt: token.usedAt,
      session: {
        id: session.id,
        clientKind: session.clientKind,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        revokedAt: session.revokedAt,
        mfaAt: session.mfaAt ?? null,
      },
      account: this.accounts.get(session.userId)!,
    };
  }

  async rotateRefreshToken(rotation: RefreshRotation): Promise<boolean> {
    const old = this.tokens.find((token) => token.id === rotation.oldTokenId)!;
    if (this.raceOnNextRotation) {
      this.raceOnNextRotation = false;
      old.usedAt = rotation.now;
    }
    if (old.usedAt) return false;
    old.usedAt = rotation.now;
    old.replacedById = rotation.newToken.id;
    this.tokens.push({ ...rotation.newToken, sessionId: rotation.sessionId, usedAt: null });
    const session = this.sessions.find((candidate) => candidate.id === rotation.sessionId)!;
    session.lastSeenAt = rotation.now;
    session.expiresAt = rotation.sessionExpiresAt;
    return true;
  }

  async revokeSession(sessionId: string, userId: string, reason: string, now: Date): Promise<number> {
    const session = this.sessions.find(
      (candidate) => candidate.id === sessionId && candidate.userId === userId && !candidate.revokedAt,
    );
    if (!session) return 0;
    session.revokedAt = now;
    session.revokeReason = reason;
    return 1;
  }

  async revokeAllSessions(userId: string, reason: string, now: Date): Promise<number> {
    const active = this.sessions.filter((session) => session.userId === userId && !session.revokedAt);
    for (const session of active) {
      session.revokedAt = now;
      session.revokeReason = reason;
    }
    return active.length;
  }
}
