/**
 * Doublures en mémoire des ports de l'application, pour les tests des cas d'usage.
 * Elles reproduisent les garanties des vrais dépôts (atomicité, unicité) sans base de données.
 */
import { type OtpChallenge, type OtpChannel } from '../../domain/otp/otp-challenge';
import { type StoredOtpChallenge } from '../../domain/otp/otp-verification';
import { type PhoneNumber } from '../../domain/user/phone-number';
import { type OtpChallengeRepository, type OtpRequestedEvent } from '../otp/otp.ports';
import {
  type Account,
  type AccountRepository,
  ChallengeAlreadyConsumedError,
  type LoginRepository,
  type PhoneLoginPlan,
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
  clientKind: string;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
  revokeReason?: string;
  refreshTokenHash: string;
}

/** Comptes, sessions et historique en mémoire ; partage la table des demandes pour les consommer. */
export class InMemoryIdentityStore implements AccountRepository, LoginRepository {
  readonly accounts: Account[] = [];
  readonly sessions: StoredSession[] = [];
  readonly loginEvents: { userId: string | null; success: boolean; reason?: string }[] = [];
  readonly registered: string[] = [];

  constructor(private readonly challenges: InMemoryChallenges) {}

  async findByPhone(phoneE164: string): Promise<Account | null> {
    return this.accounts.find((account) => account.phoneE164 === phoneE164) ?? null;
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

    const active = this.sessions
      .filter((session) => session.userId === account.id && !session.revokedAt)
      .sort((a, b) => a.lastSeenAt.getTime() - b.lastSeenAt.getTime());
    for (const session of active.slice(0, Math.max(0, active.length + 1 - plan.maxSessions))) {
      session.revokedAt = plan.now;
      session.revokeReason = 'session_limit';
    }
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

  async recordFailedLogin(event: { userId: string | null; reason: string }): Promise<void> {
    this.loginEvents.push({ userId: event.userId, success: false, reason: event.reason });
  }
}
