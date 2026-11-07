/**
 * Doublure en mémoire de l'administration des comptes (ADR-038), adossée aux rôles en mémoire :
 * mêmes règles que le dépôt réel (transition conditionnelle, dernier super administrateur, audit).
 */
import { type RoleDefinition } from '../../domain/role/role';
import {
  type AccountAdminRepository,
  type AccountAuditView,
  type AccountSearch,
  type AccountStatusChange,
  AccountStatusChangedError,
  type AdminAccountView,
  type MfaStatusView,
  type RoleAssignmentView,
} from '../account-admin/account-admin.ports';
import { LastSuperAdminError } from '../role/role.ports';
import { type InMemoryRoles } from './mfa-fakes';

export type FakeAdminAccount = Omit<AdminAccountView, 'roleCodes'>;

export interface FakeMfa {
  configuredAt: Date | null;
  unusedCodes: number;
}

export class InMemoryAccountAdmin implements AccountAdminRepository {
  readonly accounts = new Map<string, FakeAdminAccount>();
  readonly mfa = new Map<string, FakeMfa>();
  /** Événements publiés (identity.user.suspended, identity.user.reactivated). */
  readonly events: { type: string; payload: Record<string, unknown> }[] = [];
  /** Sessions fermées : compte et motif. */
  readonly revokedSessions: { userId: string; reason: string }[] = [];
  /** Simule une autre décision passée juste avant l'écriture. */
  raceOnNextChange = false;

  constructor(private readonly roles: InMemoryRoles) {
    roles.statusOf = (userId) => this.accounts.get(userId)?.status ?? 'deleted';
  }

  add(account: Partial<FakeAdminAccount> & { id: string }): FakeAdminAccount {
    const full: FakeAdminAccount = {
      status: 'active',
      firstName: null,
      lastName: null,
      phoneE164: null,
      createdAt: new Date('2026-10-01T08:00:00Z'),
      suspendedAt: null,
      suspensionReason: null,
      ...account,
    };
    this.accounts.set(full.id, full);
    return full;
  }

  async search(search: AccountSearch): Promise<{ items: AdminAccountView[]; nextCursor: string | null }> {
    const { query } = search;
    const matches = [...this.accounts.values()]
      .filter((account) => account.status !== 'deleted')
      .filter((account) => !search.cursor || account.id < search.cursor)
      .filter((account) => query.kind !== 'phone' || account.phoneE164 === query.e164)
      .filter(
        (account) =>
          query.kind !== 'name' ||
          query.words.every((word) =>
            [account.firstName, account.lastName].some((name) =>
              name?.toLowerCase().includes(word.toLowerCase()),
            ),
          ),
      )
      .filter((account) => {
        if (query.kind !== 'staff' && !search.teamOf) return true;
        return this.roles.assignments.some(
          (assignment) =>
            assignment.userId === account.id &&
            !assignment.revokedAt &&
            (!search.teamOf || search.teamOf.includes(assignment.role.service)),
        );
      })
      .sort((a, b) => b.id.localeCompare(a.id))
      .map((account) => this.view(account));
    const items = matches.slice(0, search.limit);
    return { items, nextCursor: matches.length > search.limit ? (items.at(-1)?.id ?? null) : null };
  }

  async findAccount(userId: string): Promise<AdminAccountView | null> {
    const account = this.accounts.get(userId);
    return account ? this.view(account) : null;
  }

  async assignments(userId: string): Promise<RoleAssignmentView[]> {
    const name = (id: string | null) => {
      const account = id ? this.accounts.get(id) : undefined;
      return account ? [account.firstName, account.lastName].filter(Boolean).join(' ') || null : null;
    };
    return this.roles.assignments
      .filter((assignment) => assignment.userId === userId)
      .sort(
        (a, b) =>
          Number(a.revokedAt !== null) - Number(b.revokedAt !== null) ||
          b.grantedAt.getTime() - a.grantedAt.getTime(),
      )
      .map((assignment) => ({
        id: assignment.id,
        role: assignment.role,
        scopeType: assignment.role.scopeType,
        scopeId: assignment.scopeId,
        grantedAt: assignment.grantedAt,
        grantedBy: assignment.grantedBy,
        grantedByName: name(assignment.grantedBy),
        grantReason: assignment.grantReason,
        revokedAt: assignment.revokedAt,
        revokedBy: assignment.revokedBy,
        revokedByName: name(assignment.revokedBy),
        revokeReason: assignment.revokeReason,
      }));
  }

  async history(userId: string, limit: number): Promise<AccountAuditView[]> {
    return (
      this.roles.audit
        .filter((entry) => entry.entityId === userId)
        // Même ordre que le dépôt réel : date, puis identifiant (UUID v7), les plus récents d'abord.
        .sort((a, b) => b.at.getTime() - a.at.getTime() || b.id.localeCompare(a.id))
        .slice(0, limit)
        .map((entry) => ({
          id: entry.id,
          action: entry.action,
          at: entry.at,
          actorId: entry.actorId,
          actorName: null,
          roleCode: typeof entry.details['roleCode'] === 'string' ? entry.details['roleCode'] : null,
          reason: typeof entry.details['reason'] === 'string' ? entry.details['reason'] : null,
        }))
    );
  }

  async mfaStatus(userId: string): Promise<MfaStatusView> {
    const mfa = this.mfa.get(userId);
    return {
      configuredAt: mfa?.configuredAt ?? null,
      recoveryCodesRemaining: mfa?.configuredAt ? mfa.unusedCodes : 0,
      resettable: mfa !== undefined,
    };
  }

  async catalog(): Promise<RoleDefinition[]> {
    return [...this.roles.definitions].sort((a, b) => a.code.localeCompare(b.code));
  }

  async changeStatus(change: AccountStatusChange): Promise<void> {
    const account = this.accounts.get(change.userId)!;
    if (this.raceOnNextChange) {
      this.raceOnNextChange = false;
      account.status = change.to;
    }
    const suspend = change.action === 'suspend';
    const holdsSuperAdmin = this.roles.assignments.some(
      (a) => a.userId === change.userId && !a.revokedAt && a.role.code === 'super_admin',
    );
    if (suspend && holdsSuperAdmin && !this.roles.anotherActiveSuperAdmin(change.userId)) {
      throw new LastSuperAdminError();
    }
    if (account.status !== change.from) throw new AccountStatusChangedError();
    Object.assign(
      account,
      suspend
        ? { status: 'suspended', suspendedAt: change.now, suspensionReason: change.reason }
        : { status: 'active', suspendedAt: null, suspensionReason: null },
    );
    if (suspend) this.revokedSessions.push({ userId: change.userId, reason: 'account_suspended' });
    this.events.push(
      suspend
        ? {
            type: 'identity.user.suspended',
            payload: { userId: change.userId, reason: change.reason, suspendedBy: change.actorId },
          }
        : {
            type: 'identity.user.reactivated',
            payload: { userId: change.userId, reactivatedBy: change.actorId },
          },
    );
    this.roles.audit.push({
      id: change.auditId,
      actorId: change.actorId,
      action: suspend ? 'user.suspended' : 'user.reactivated',
      entityId: change.userId,
      at: change.now,
      details: { from: change.from, to: change.to, reason: change.reason },
    });
  }

  async resetMfa(change: {
    userId: string;
    actorId: string;
    reason: string;
    auditId: string;
    now: Date;
  }): Promise<boolean> {
    if (!this.mfa.delete(change.userId)) return false;
    this.revokedSessions.push({ userId: change.userId, reason: 'mfa_reset' });
    this.roles.audit.push({
      id: change.auditId,
      actorId: change.actorId,
      action: 'user.mfa_reset',
      entityId: change.userId,
      at: change.now,
      details: { reason: change.reason },
    });
    return true;
  }

  private view(account: FakeAdminAccount): AdminAccountView {
    return {
      ...account,
      roleCodes: this.roles.assignments
        .filter((assignment) => assignment.userId === account.id && !assignment.revokedAt)
        .sort((a, b) => a.grantedAt.getTime() - b.grantedAt.getTime())
        .map((assignment) => assignment.role.code),
    };
  }
}
