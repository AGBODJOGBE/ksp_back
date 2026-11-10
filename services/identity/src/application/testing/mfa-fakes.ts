/**
 * Doublures en mémoire des rôles et de la double authentification. Comme les vrais dépôts, la
 * connexion back-office est tout ou rien : une preuve refusée ne modifie rien.
 */
import { type StoredMfaChallenge } from '../../domain/mfa/mfa-challenge';
import { type AssignedRole, INITIAL_BACKOFFICE_ROLES, type RoleDefinition } from '../../domain/role/role';
import {
  MfaChallengeAlreadyConsumedError,
  type MfaChallengeRepository,
  type MfaFactorRepository,
  type MfaLoginPlan,
  type MfaLoginRepository,
  type NewMfaChallenge,
  RecoveryCodeAlreadyUsedError,
  TotpAlreadyEnabledError,
  type TotpFactor,
  TotpStepAlreadyUsedError,
} from '../mfa/mfa.ports';
import {
  LastSuperAdminError,
  RoleAssignmentNotFoundError,
  RoleAssignmentRevokedError,
  type RoleGrant,
  type RoleRepository,
  type RoleRevocation,
} from '../role/role.ports';
import { type Account, ChallengeAlreadyConsumedError } from '../session/session.ports';
import { type InMemoryChallenges, type InMemoryIdentityStore } from './fakes';

export interface FakeAssignment {
  id: string;
  userId: string;
  role: RoleDefinition;
  scopeId: string | null;
  grantedBy: string | null;
  grantedAt: Date;
  grantReason: string | null;
  revokedAt: Date | null;
  revokedBy: string | null;
  revokeReason: string | null;
}

/** Trace d'audit écrite par une doublure (même forme que audit_log). */
export interface FakeAuditEntry {
  id: string;
  actorId: string;
  action: string;
  entityId: string;
  at: Date;
  details: Record<string, unknown>;
}

export class InMemoryRoles implements RoleRepository {
  readonly definitions: RoleDefinition[] = [...INITIAL_BACKOFFICE_ROLES];
  readonly assignments: FakeAssignment[] = [];
  /** Événements identity.role.granted écrits. */
  readonly granted: RoleGrant[] = [];
  /** Événements identity.role.revoked écrits. */
  readonly revoked: (RoleRevocation & { roleCode: string })[] = [];
  /** Traces d'audit écrites (attributions et retraits du back-office). */
  readonly audit: FakeAuditEntry[] = [];
  /** État des comptes, pour la règle du dernier super administrateur actif. */
  statusOf: (userId: string) => string = () => 'active';

  /** Attribution directe, pour préparer un test. */
  assign(userId: string, code: string, id = `a-${code}`): void {
    const role = this.definitions.find((definition) => definition.code === code)!;
    const scopeId = role.scopeType === 'domain' ? role.service : null;
    this.assignments.push({
      id,
      userId,
      role,
      scopeId,
      grantedBy: null,
      grantedAt: new Date('2026-10-01T08:00:00Z'),
      grantReason: null,
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
    });
  }

  async activeRoles(userId: string): Promise<AssignedRole[]> {
    return this.assignments
      .filter((assignment) => assignment.userId === userId && !assignment.revokedAt)
      .map(({ role, scopeId }) => ({
        code: role.code,
        scopeType: role.scopeType,
        scopeId,
        requiresMfa: role.requiresMfa,
        backofficeAccess: role.backofficeAccess,
      }));
  }

  async findDefinition(code: string): Promise<RoleDefinition | null> {
    return this.definitions.find((definition) => definition.code === code) ?? null;
  }

  async grant(input: Parameters<RoleRepository['grant']>[0]): Promise<RoleGrant> {
    const existing = this.assignments.find(
      (assignment) =>
        assignment.userId === input.userId &&
        assignment.role.code === input.roleCode &&
        assignment.scopeId === input.scopeId &&
        !assignment.revokedAt,
    );
    const base = { userId: input.userId, roleCode: input.roleCode, scopeType: input.scopeType };
    if (existing) return { ...base, assignmentId: existing.id, scopeId: existing.scopeId, created: false };
    const role = this.definitions.find((definition) => definition.code === input.roleCode)!;
    this.assignments.push({
      id: input.assignmentId,
      userId: input.userId,
      role,
      scopeId: input.scopeId,
      grantedBy: input.grantedBy,
      grantedAt: input.now,
      grantReason: input.audit?.reason ?? null,
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
    });
    const grant = { ...base, assignmentId: input.assignmentId, scopeId: input.scopeId, created: true };
    this.granted.push(grant);
    if (input.audit && input.grantedBy) {
      this.audit.push({
        id: input.audit.id,
        actorId: input.grantedBy,
        action: 'user.role_granted',
        entityId: input.userId,
        at: input.now,
        details: { roleCode: input.roleCode, reason: input.audit.reason },
      });
    }
    return grant;
  }

  async revoke(revocation: RoleRevocation): Promise<{ roleCode: string }> {
    const assignment = this.assignments.find(
      (candidate) => candidate.id === revocation.assignmentId && candidate.userId === revocation.userId,
    );
    if (!assignment) throw new RoleAssignmentNotFoundError();
    if (assignment.revokedAt) throw new RoleAssignmentRevokedError();
    const roleCode = assignment.role.code;
    if (roleCode === 'super_admin' && !this.anotherActiveSuperAdmin(revocation.userId)) {
      throw new LastSuperAdminError();
    }
    Object.assign(assignment, {
      revokedAt: revocation.now,
      revokedBy: revocation.actorId,
      revokeReason: revocation.reason,
    });
    this.revoked.push({ ...revocation, roleCode });
    this.audit.push({
      id: revocation.auditId,
      actorId: revocation.actorId,
      action: 'user.role_revoked',
      entityId: revocation.userId,
      at: revocation.now,
      details: { roleCode, reason: revocation.reason },
    });
    return { roleCode };
  }

  /** Un autre compte actif garde-t-il le rôle super_admin ? */
  anotherActiveSuperAdmin(userId: string): boolean {
    return this.assignments.some(
      (candidate) =>
        candidate.role.code === 'super_admin' &&
        !candidate.revokedAt &&
        candidate.userId !== userId &&
        this.statusOf(candidate.userId) === 'active',
    );
  }
}

type FakeMfaChallenge = StoredMfaChallenge & { tokenHash: string; ip: string | null };

export class InMemoryMfaStore implements MfaChallengeRepository, MfaFactorRepository, MfaLoginRepository {
  readonly challenges = new Map<string, FakeMfaChallenge>();
  readonly factors: (TotpFactor & { userId: string })[] = [];
  readonly recoveryCodes: { id: string; userId: string; hash: string; usedAt: Date | null }[] = [];
  /** Simule une autre connexion qui consomme la même preuve juste avant (course entre deux requêtes). */
  raceOnNextLogin = false;

  constructor(
    private readonly otp: InMemoryChallenges,
    private readonly identity: InMemoryIdentityStore,
  ) {}

  async openAfterOtp(otpChallengeId: string, challenge: NewMfaChallenge, now: Date): Promise<void> {
    const otp = this.otp.rows.get(otpChallengeId)!;
    if (otp.consumedAt) throw new ChallengeAlreadyConsumedError();
    otp.consumedAt = now;
    this.challenges.set(challenge.id, { ...challenge, attempts: 0, consumedAt: null });
  }

  async findByTokenHash(tokenHash: string): Promise<StoredMfaChallenge | null> {
    const found = [...this.challenges.values()].find((challenge) => challenge.tokenHash === tokenHash);
    return found ? { ...found } : null;
  }

  async takeAttempt(id: string, maxAttempts: number, now: Date): Promise<number | null> {
    const challenge = this.challenges.get(id)!;
    if (challenge.consumedAt || challenge.expiresAt <= now || challenge.attempts >= maxAttempts) return null;
    challenge.attempts += 1;
    return challenge.attempts;
  }

  async findTotp(userId: string): Promise<TotpFactor | null> {
    const factor = this.factors.find((candidate) => candidate.userId === userId);
    return factor ? { ...factor } : null;
  }

  async savePendingTotp(input: { id: string; userId: string; secretEncrypted: string }): Promise<void> {
    const index = this.factors.findIndex((factor) => factor.userId === input.userId);
    if (index >= 0 && this.factors[index]!.enabledAt) throw new TotpAlreadyEnabledError();
    const pending = { ...input, enabledAt: null, lastUsedStep: null };
    if (index >= 0) this.factors[index] = pending;
    else this.factors.push(pending);
  }

  async countUnusedRecoveryCodes(userId: string): Promise<number> {
    return this.recoveryCodes.filter((code) => code.userId === userId && !code.usedAt).length;
  }

  async findUnusedRecoveryCode(userId: string, codeHash: string): Promise<string | null> {
    const code = this.recoveryCodes.find(
      (candidate) => candidate.userId === userId && candidate.hash === codeHash && !candidate.usedAt,
    );
    return code?.id ?? null;
  }

  async completeMfaLogin(plan: MfaLoginPlan): Promise<{ account: Account; recoveryCodesRemaining: number }> {
    const challenge = this.challenges.get(plan.mfaChallengeId)!;
    if (challenge.consumedAt) throw new MfaChallengeAlreadyConsumedError();
    const applyProof = this.checkProof(plan);
    const race = this.raceOnNextLogin;
    this.raceOnNextLogin = false;
    if (race)
      throw plan.proof.kind === 'recovery_code'
        ? new RecoveryCodeAlreadyUsedError()
        : new TotpStepAlreadyUsedError();

    challenge.consumedAt = plan.now;
    applyProof();
    this.identity.applySessionLimit(plan.userId, plan.session.clientKind, plan.maxSessions, plan.now);
    this.identity.sessions.push({
      id: plan.session.id,
      userId: plan.userId,
      clientKind: plan.session.clientKind,
      deviceLabel: plan.session.deviceLabel,
      lastSeenAt: plan.now,
      expiresAt: plan.session.expiresAt,
      refreshTokenHash: plan.refreshToken.hash,
      mfaAt: plan.now,
    });
    this.identity.loginEvents.push({
      userId: plan.userId,
      success: true,
      method: plan.proof.kind === 'recovery_code' ? 'recovery_code' : 'totp',
    });
    const account = this.identity.accounts.find((candidate) => candidate.id === plan.userId)!;
    return { account, recoveryCodesRemaining: await this.countUnusedRecoveryCodes(plan.userId) };
  }

  /** Vérifie la preuve sans rien modifier ; renvoie l'écriture à faire si tout passe. */
  private checkProof(plan: MfaLoginPlan): () => void {
    const { proof, now, userId } = plan;
    if (proof.kind === 'recovery_code') {
      const code = this.recoveryCodes.find((candidate) => candidate.id === proof.codeId)!;
      if (code.usedAt) throw new RecoveryCodeAlreadyUsedError();
      return () => {
        code.usedAt = now;
      };
    }
    const factor = this.factors.find((candidate) => candidate.id === proof.factorId)!;
    if (proof.kind === 'totp_enrollment') {
      if (factor.enabledAt) throw new TotpAlreadyEnabledError();
      return () => {
        factor.enabledAt = now;
        factor.lastUsedStep = proof.step;
        const kept = this.recoveryCodes.filter((code) => code.userId !== userId || code.usedAt);
        this.recoveryCodes.splice(0, this.recoveryCodes.length, ...kept);
        this.recoveryCodes.push(...proof.recoveryCodes.map((code) => ({ ...code, userId, usedAt: null })));
      };
    }
    if (factor.lastUsedStep !== null && proof.step <= factor.lastUsedStep)
      throw new TotpStepAlreadyUsedError();
    return () => {
      factor.lastUsedStep = proof.step;
    };
  }
}
