/**
 * Doublures en mémoire des ports de l'application, pour les tests des cas d'usage.
 * Elles reproduisent les garanties des vrais dépôts (atomicité, unicité) sans base de données.
 */
import { type Organization, type OrganizationStatus } from '../../domain/organization/organization';
import { type OtpChallenge, type OtpChannel } from '../../domain/otp/otp-challenge';
import { clientKindsOf, sessionCategory } from '../../domain/session/session-policy';
import { type StoredOtpChallenge } from '../../domain/otp/otp-verification';
import { type PhoneNumber } from '../../domain/user/phone-number';
import { type EmailAddress } from '../../domain/user/email-address';
import {
  type EmailCodeRequestedEvent,
  type EmailConfirmation,
  EmailAlreadyUsedError,
  type EmailVerificationRepository,
  type NewEmailVerification,
  type OrganizationEmailConfirmation,
  type StoredEmailVerification,
  VerificationAlreadyConsumedError,
} from '../email/email.ports';
import {
  type Membership,
  type NewOrganization,
  OrganizationChangedError,
  OrganizationIfuTakenError,
  type OrganizationMemberView,
  type OrganizationPage,
  type OrganizationRepository,
  type OrganizationStatusChange,
} from '../organization/organization.ports';
import { type OtpChallengeRepository, type OtpRequestedEvent } from '../otp/otp.ports';
import {
  type RefreshRotation,
  type SessionStore,
  type StoredRefreshToken,
  type StoredSession as StoredSessionView,
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
        emailVerifiedAt: null,
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
  activeOrgId?: string | null;
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
        activeOrgId: session.activeOrgId ?? null,
      },
      account: this.accounts.get(session.userId)!,
    };
  }

  async findSession(sessionId: string): Promise<StoredSessionView | null> {
    const session = this.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return null;
    return {
      id: session.id,
      userId: session.userId,
      clientKind: session.clientKind,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
      account: this.accounts.get(session.userId)!,
    };
  }

  async setActiveOrganization(
    sessionId: string,
    userId: string,
    organizationId: string | null,
  ): Promise<boolean> {
    const session = this.sessions.find(
      (candidate) => candidate.id === sessionId && candidate.userId === userId && !candidate.revokedAt,
    );
    if (!session) return false;
    session.activeOrgId = organizationId;
    return true;
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
    session.activeOrgId = rotation.activeOrgId;
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

type VerificationRow = NewEmailVerification & {
  attempts: number;
  sentAt?: Date;
  sendFailedAt?: Date;
  consumedAt?: Date;
};

/** Demandes de confirmation d'e-mail en mémoire ; la confirmation écrit dans les comptes du magasin. */
export class InMemoryEmailVerifications implements EmailVerificationRepository {
  readonly rows: VerificationRow[] = [];
  readonly events: EmailCodeRequestedEvent[] = [];
  readonly verifiedEvents: string[] = [];

  constructor(
    private readonly store: InMemoryIdentityStore,
    private readonly organizations?: InMemoryOrganizations,
  ) {}

  async sentAtForEmailSince(email: EmailAddress, since: Date): Promise<Date[]> {
    return this.sentSince((row) => row.email.value === email.value, since);
  }
  async sentAtForUserSince(userId: string, since: Date): Promise<Date[]> {
    return this.sentSince((row) => row.userId === userId, since);
  }
  async create(verification: NewEmailVerification): Promise<void> {
    this.rows.push({ ...verification, attempts: 0 });
  }
  async markSent(id: string, sentAt: Date, event: EmailCodeRequestedEvent): Promise<void> {
    this.row(id).sentAt = sentAt;
    this.events.push(event);
  }
  async markSendFailed(id: string, failedAt: Date): Promise<void> {
    this.row(id).sendFailedAt = failedAt;
  }
  async findLatest(userId: string): Promise<StoredEmailVerification | null> {
    return this.stored(
      this.rows
        .filter((candidate) => candidate.userId === userId && candidate.organizationId === null)
        .at(-1),
    );
  }
  async findLatestForOrganization(organizationId: string): Promise<StoredEmailVerification | null> {
    return this.stored(this.rows.filter((candidate) => candidate.organizationId === organizationId).at(-1));
  }
  private stored(row: VerificationRow | undefined): StoredEmailVerification | null {
    if (!row) return null;
    return {
      id: row.id,
      userId: row.userId,
      target: row.email.value,
      codeHash: row.codeHash,
      attempts: row.attempts,
      expiresAt: row.expiresAt,
      sentAt: row.sentAt ?? null,
      sendFailedAt: row.sendFailedAt ?? null,
      consumedAt: row.consumedAt ?? null,
    };
  }
  async registerFailedAttempt(id: string): Promise<number> {
    const row = this.row(id);
    row.attempts += 1;
    return row.attempts;
  }
  async confirm(confirmation: EmailConfirmation): Promise<Account> {
    const row = this.row(confirmation.verificationId);
    if (row.consumedAt) throw new VerificationAlreadyConsumedError();
    const taken = this.store.accounts.some(
      (account) => account.email === confirmation.email && account.id !== confirmation.userId,
    );
    if (taken) throw new EmailAlreadyUsedError();
    row.consumedAt = confirmation.now;
    const account = this.store.accounts.find((candidate) => candidate.id === confirmation.userId)!;
    Object.assign(account, { email: confirmation.email, emailVerifiedAt: confirmation.now });
    this.verifiedEvents.push(account.id);
    return account;
  }

  async confirmForOrganization(confirmation: OrganizationEmailConfirmation): Promise<void> {
    const row = this.row(confirmation.verificationId);
    if (row.consumedAt || row.organizationId !== confirmation.organizationId) {
      throw new VerificationAlreadyConsumedError();
    }
    row.consumedAt = confirmation.now;
    const organization = this.organizations?.rows.find(
      (candidate) => candidate.id === confirmation.organizationId,
    );
    if (organization) organization.billingEmail = confirmation.email;
  }

  private row(id: string): VerificationRow {
    return this.rows.find((candidate) => candidate.id === id)!;
  }

  private sentSince(match: (row: VerificationRow) => boolean, since: Date): Date[] {
    return this.rows
      .filter((row) => match(row) && row.sentAt && row.sentAt >= since)
      .map((row) => row.sentAt as Date);
  }
}

interface FakeMember {
  organizationId: string;
  userId: string;
  role: Membership['role'];
  joinedAt: Date;
  removedAt: Date | null;
}

/** Organisations, membres et décisions en mémoire, avec l'unicité de l'IFU et les transitions conditionnelles. */
export class InMemoryOrganizations implements OrganizationRepository {
  readonly rows: Organization[] = [];
  readonly memberRows: FakeMember[] = [];
  readonly events: { type: string; payload: Record<string, unknown> }[] = [];
  readonly audit: OrganizationStatusChange[] = [];
  /** Simule une autre décision qui passe juste avant (course entre deux requêtes). */
  raceOnNextDecision: OrganizationStatus | null = null;

  constructor(private readonly accounts: { accounts: Account[] } = { accounts: [] }) {}

  async countPendingCreatedBy(userId: string): Promise<number> {
    return this.rows.filter((row) => row.createdBy === userId && row.status === 'pending_review').length;
  }

  async create(input: NewOrganization): Promise<Membership> {
    if (this.rows.some((row) => row.ifu === input.ifu && row.status !== 'rejected')) {
      throw new OrganizationIfuTakenError();
    }
    const organization: Organization = {
      id: input.id,
      legalName: input.legalName,
      address: input.address,
      ifu: input.ifu,
      rccm: input.rccm,
      billingEmail: null,
      status: 'pending_review',
      createdBy: input.createdBy,
      createdAt: input.now,
      reviewedBy: null,
      reviewedAt: null,
      rejectionReason: null,
      suspendedAt: null,
      suspensionReason: null,
    };
    this.rows.push(organization);
    this.memberRows.push({
      organizationId: input.id,
      userId: input.createdBy,
      role: 'org_admin',
      joinedAt: input.now,
      removedAt: null,
    });
    this.events.push(
      {
        type: 'identity.organization.created',
        payload: { organizationId: input.id, createdBy: input.createdBy, legalName: input.legalName },
      },
      {
        type: 'identity.member.added',
        payload: { organizationId: input.id, userId: input.createdBy, orgRole: 'org_admin' },
      },
    );
    return { organization, role: 'org_admin' };
  }

  async findById(organizationId: string): Promise<Organization | null> {
    return this.rows.find((row) => row.id === organizationId) ?? null;
  }

  async membership(userId: string, organizationId: string): Promise<Membership | null> {
    const member = this.memberRows.find(
      (candidate) =>
        candidate.userId === userId && candidate.organizationId === organizationId && !candidate.removedAt,
    );
    const organization = member && (await this.findById(organizationId));
    return member && organization ? { organization, role: member.role } : null;
  }

  async memberships(userId: string): Promise<Membership[]> {
    const found = await Promise.all(
      this.memberRows
        .filter((member) => member.userId === userId && !member.removedAt)
        .map((member) => this.membership(userId, member.organizationId)),
    );
    return found
      .filter((membership): membership is Membership => membership !== null)
      .sort((a, b) => b.organization.id.localeCompare(a.organization.id));
  }

  async list(
    filter: { status: OrganizationStatus | null },
    page: { limit: number; cursor: string | null },
  ): Promise<OrganizationPage> {
    const rows = this.rows
      .filter((row) => !filter.status || row.status === filter.status)
      .filter((row) => !page.cursor || row.id < page.cursor)
      .sort((a, b) => b.id.localeCompare(a.id));
    const items = rows.slice(0, page.limit);
    return { items, nextCursor: rows.length > page.limit ? (items.at(-1)?.id ?? null) : null };
  }

  async members(organizationId: string): Promise<OrganizationMemberView[]> {
    return this.memberRows
      .filter((member) => member.organizationId === organizationId && !member.removedAt)
      .map((member) => {
        const account = this.accounts.accounts.find((candidate) => candidate.id === member.userId);
        return {
          userId: member.userId,
          role: member.role,
          firstName: account?.firstName ?? null,
          lastName: account?.lastName ?? null,
          phoneE164: account?.phoneE164 ?? null,
          joinedAt: member.joinedAt,
        };
      });
  }

  async applyDecision(change: OrganizationStatusChange): Promise<Organization> {
    const organization = this.rows.find((row) => row.id === change.organizationId)!;
    if (this.raceOnNextDecision) {
      organization.status = this.raceOnNextDecision;
      this.raceOnNextDecision = null;
    }
    if (organization.status !== change.from) throw new OrganizationChangedError();
    organization.status = change.to;
    if (change.decision === 'validate' || change.decision === 'reject') {
      organization.reviewedBy = change.actorId;
      organization.reviewedAt = change.now;
    }
    if (change.decision === 'reject') organization.rejectionReason = change.reason;
    if (change.decision === 'suspend') {
      organization.suspendedAt = change.now;
      organization.suspensionReason = change.reason;
    }
    if (change.decision === 'reactivate') {
      organization.suspendedAt = null;
      organization.suspensionReason = null;
    }
    this.events.push({ type: `identity.organization.${change.decision}`, payload: { ...change } });
    this.audit.push(change);
    return organization;
  }
}
