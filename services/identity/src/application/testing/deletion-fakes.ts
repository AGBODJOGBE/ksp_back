/** Doublures en mémoire de la suppression du compte (UC-ID-11), pour les tests des cas d'usage. */
import { type DeletionObstacle, type SoleAdministeredOrganization } from '../../domain/user/account-deletion';
import {
  type AccountDeletionRepository,
  type DeletionRequestPlan,
  type ObligationCheck,
  type ObligationChecker,
} from '../deletion/account-deletion.ports';
import { type InMemoryIdentityStore } from './fakes';

interface FakeAdministration {
  organization: SoleAdministeredOrganization;
  admins: string[];
  rejected?: boolean;
}

/** Comptes et sessions d'un InMemoryIdentityStore, avec la même garde d'état que le vrai dépôt. */
export class InMemoryAccountDeletions implements AccountDeletionRepository {
  readonly administrations: FakeAdministration[] = [];
  readonly events: { type: string; payload: Record<string, unknown> }[] = [];
  readonly checks: { userId: string; at: Date; obstacles?: DeletionObstacle[] }[] = [];
  readonly anonymizedPhones: string[] = [];

  constructor(private readonly store: InMemoryIdentityStore) {}

  private account(userId: string) {
    return this.store.accounts.find((account) => account.id === userId);
  }

  async soleAdministeredOrganizations(userId: string): Promise<SoleAdministeredOrganization[]> {
    return this.administrations
      .filter((entry) => !entry.rejected && entry.admins.includes(userId))
      .filter(
        (entry) =>
          !entry.admins.some((admin) => {
            const status = this.account(admin)?.status;
            return admin !== userId && status !== 'deletion_pending' && status !== 'deleted';
          }),
      )
      .map((entry) => entry.organization);
  }

  async requestDeletion(plan: DeletionRequestPlan): Promise<boolean> {
    const account = this.account(plan.userId);
    if (!account || account.status !== 'active') return false;
    account.status = 'deletion_pending';
    account.deletion = { requestedAt: plan.requestedAt, scheduledFor: plan.scheduledFor, postponedBy: [] };
    for (const session of this.store.sessions) {
      if (session.userId === plan.userId && !session.revokedAt) {
        session.revokedAt = plan.requestedAt;
        session.revokeReason = 'account_deletion_requested';
      }
    }
    this.events.push({
      type: 'identity.user.deletion_requested',
      payload: {
        userId: plan.userId,
        requestedAt: plan.requestedAt.toISOString(),
        scheduledFor: plan.scheduledFor.toISOString(),
      },
    });
    return true;
  }

  async cancelDeletion(userId: string): Promise<boolean> {
    const account = this.account(userId);
    if (!account || account.status !== 'deletion_pending') return false;
    account.status = 'active';
    account.deletion = null;
    this.events.push({ type: 'identity.user.deletion_cancelled', payload: { userId } });
    return true;
  }

  async listDue(input: { now: Date; recheckBefore: Date; limit: number }): Promise<string[]> {
    return this.store.accounts
      .filter(
        (account) =>
          account.status === 'deletion_pending' &&
          account.deletion &&
          account.deletion.scheduledFor <= input.now &&
          !this.checks.some((check) => check.userId === account.id && check.at > input.recheckBefore),
      )
      .slice(0, input.limit)
      .map((account) => account.id);
  }

  async markChecked(userId: string, at: Date, obstacles?: DeletionObstacle[]): Promise<void> {
    this.checks.push({ userId, at, ...(obstacles ? { obstacles } : {}) });
    const account = this.account(userId);
    if (obstacles && account?.deletion) account.deletion.postponedBy = obstacles;
  }

  async anonymize(userId: string, now: Date): Promise<boolean> {
    const account = this.account(userId);
    if (!account || account.status !== 'deletion_pending' || !account.deletion) return false;
    if (account.deletion.scheduledFor > now) return false;
    if (account.phoneE164) this.anonymizedPhones.push(account.phoneE164);
    Object.assign(account, {
      status: 'deleted',
      firstName: null,
      lastName: null,
      email: null,
      emailVerifiedAt: null,
      phoneE164: null,
      deletion: null,
    });
    const sessions = this.store.sessions.filter((session) => session.userId !== userId);
    this.store.sessions.splice(0, this.store.sessions.length, ...sessions);
    for (const entry of this.administrations) {
      if (entry.admins.includes(userId)) {
        entry.admins = entry.admins.filter((admin) => admin !== userId);
        this.events.push({
          type: 'identity.member.removed',
          payload: { organizationId: entry.organization.id, userId, removedBy: userId },
        });
      }
    }
    this.events.push({ type: 'identity.user.deleted', payload: { userId } });
    return true;
  }
}

/** Réponses des services interrogés, réglables par test ; compte les appels. */
export class FakeObligationChecker implements ObligationChecker {
  readonly calls: string[] = [];
  next: ObligationCheck = { status: 'clear' };
  byUser = new Map<string, ObligationCheck>();

  async check(userId: string): Promise<ObligationCheck> {
    this.calls.push(userId);
    return this.byUser.get(userId) ?? this.next;
  }
}
