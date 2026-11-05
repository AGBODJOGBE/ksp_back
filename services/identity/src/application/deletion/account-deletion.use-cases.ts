import { type ActiveContext, PERSONAL_CONTEXT } from '../../domain/context/active-context';
import { backofficeRoles } from '../../domain/role/role';
import { sessionCategory } from '../../domain/session/session-policy';
import {
  type AccountDeletion,
  type DeletionObstacle,
  type DeletionPolicy,
  lastAdminObstacles,
  scheduledDeletionDate,
} from '../../domain/user/account-deletion';
import { isProfileIncomplete } from '../../domain/user/profile';
import { isUuid } from '../context/active-contexts';
import { CUSTOMER_ROLE } from '../role/role-claims';
import { type RoleRepository } from '../role/role.ports';
import { type Clock } from '../shared/system.ports';
import { type SessionStore } from '../session/session-store.ports';
import { type Account, type AccountRepository } from '../session/session.ports';
import { type AccessTokenIssuer } from '../token/access-token-issuer';
import { type AccountDeletionRepository, type ObligationChecker } from './account-deletion.ports';
import { deletionErrors } from './deletion-errors';

/**
 * UC-ID-11 : demander la suppression de son compte (ADR-036). Refusée pour un compte interne
 * (rôle du back-office), pour le seul administrateur d'un compte entreprise, et dès qu'un service
 * signale une obligation en cours ou ne répond pas. Acceptée : le compte est gelé jusqu'à la date
 * prévue (demande + délai) et toutes ses sessions sont fermées. Idempotent : un compte déjà en
 * attente rend la suppression prévue, sans nouveau contrôle.
 */
export class RequestDeletionUseCase {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly deletions: AccountDeletionRepository,
    private readonly roles: Pick<RoleRepository, 'activeRoles'>,
    private readonly obligations: ObligationChecker,
    private readonly clock: Clock,
    private readonly policy: Pick<DeletionPolicy, 'delayDays'>,
  ) {}

  async execute(userId: string): Promise<AccountDeletion> {
    const account = await this.accounts.findById(userId);
    if (!account || account.status === 'deleted') throw deletionErrors.notFound();
    if (account.status === 'deletion_pending' && account.deletion) return account.deletion;
    if (account.status !== 'active') throw deletionErrors.suspended();

    if (backofficeRoles(await this.roles.activeRoles(userId)).length > 0) {
      throw deletionErrors.internalAccount();
    }
    const organizations = await this.deletions.soleAdministeredOrganizations(userId);
    if (organizations.length > 0) throw deletionErrors.lastOrgAdmin(organizations);

    const check = await this.obligations.check(userId);
    if (check.status === 'unavailable') throw deletionErrors.unavailable(check.services);
    if (check.status === 'blocked') throw deletionErrors.blocked(check.obstacles);

    const requestedAt = this.clock.now();
    const scheduledFor = scheduledDeletionDate(requestedAt, this.policy.delayDays);
    if (await this.deletions.requestDeletion({ userId, requestedAt, scheduledFor })) {
      return { requestedAt, scheduledFor, postponedBy: [] };
    }
    // Le compte a changé entre-temps (deux demandes simultanées, suspension) : on relit.
    const current = await this.accounts.findById(userId);
    if (current?.status === 'deletion_pending' && current.deletion) return current.deletion;
    if (!current || current.status === 'deleted') throw deletionErrors.notFound();
    throw deletionErrors.suspended();
  }
}

export interface CancelledDeletion {
  account: Account;
  profileIncomplete: boolean;
  activeContext: ActiveContext;
  accessToken: string;
  accessTokenExpiresAt: Date;
}

/**
 * UC-ID-11 : annuler la suppression pendant le délai, depuis une session ouverte après la demande
 * (celles d'avant sont toutes fermées) : le compte redevient actif et un jeton d'accès complet
 * (rôle client, contexte personnel) remplace le jeton restreint, pour la même session.
 * Idempotent : un compte déjà actif reçoit simplement un nouveau jeton.
 */
export class CancelDeletionUseCase {
  constructor(
    private readonly sessions: Pick<SessionStore, 'findSession'>,
    private readonly accounts: AccountRepository,
    private readonly deletions: Pick<AccountDeletionRepository, 'cancelDeletion'>,
    private readonly accessTokens: AccessTokenIssuer,
    private readonly clock: Clock,
  ) {}

  async execute(input: { userId: string; sessionId: string }): Promise<CancelledDeletion> {
    const now = this.clock.now();
    const session = isUuid(input.sessionId) ? await this.sessions.findSession(input.sessionId) : null;
    if (
      !session ||
      session.userId !== input.userId ||
      session.revokedAt ||
      session.expiresAt <= now ||
      sessionCategory(session.clientKind) !== 'customer'
    ) {
      throw deletionErrors.sessionRevoked();
    }
    const status = session.account.status;
    if (status === 'deleted') throw deletionErrors.notFound();
    if (status === 'suspended') throw deletionErrors.suspended();
    if (status === 'deletion_pending') await this.deletions.cancelDeletion(input.userId, now);

    const account = await this.accounts.findById(input.userId);
    if (!account || account.status === 'deleted') throw deletionErrors.notFound();
    // Annulation concurrente avec l'anonymisation, ou suspension : rien n'est rendu.
    if (account.status !== 'active') {
      throw account.status === 'deletion_pending' ? deletionErrors.pending() : deletionErrors.suspended();
    }

    const access = await this.accessTokens.issue({
      userId: account.id,
      sessionId: session.id,
      clientId: session.clientKind,
      activeContext: PERSONAL_CONTEXT,
      roles: [CUSTOMER_ROLE],
      mfa: false,
      // Une annulation n'est pas une authentification : heure de la connexion.
      authTime: session.createdAt,
      amr: ['otp'],
    });
    return {
      account,
      profileIncomplete: isProfileIncomplete(account),
      activeContext: access.activeContext,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
    };
  }
}

/** Bilan d'un passage de la tâche d'anonymisation. */
export interface AnonymizationRun {
  anonymized: string[];
  /** Suppressions reportées : une obligation est apparue pendant le délai. */
  postponed: { userId: string; obstacles: DeletionObstacle[] }[];
  /** Contrôle impossible (service injoignable) : nouvel essai au passage suivant le délai de contrôle. */
  unchecked: { userId: string; services: string[] }[];
}

/**
 * Anonymisation des comptes dont le délai de suppression est échu (UC-ID-11, ADR-036). Les mêmes
 * contrôles qu'à la demande sont refaits juste avant : une obligation apparue entre-temps (ou un
 * service injoignable) reporte l'anonymisation, qui sera retentée. Idempotente et par lots :
 * l'anonymisation ne s'applique qu'à un compte encore en attente et échu, plusieurs instances
 * peuvent tourner, une annulation de dernière minute l'emporte.
 */
export class AnonymizeDueAccountsUseCase {
  constructor(
    private readonly deletions: AccountDeletionRepository,
    private readonly obligations: ObligationChecker,
    private readonly clock: Clock,
    private readonly policy: Pick<DeletionPolicy, 'recheckMinutes' | 'batchSize'>,
  ) {}

  async execute(): Promise<AnonymizationRun> {
    const now = this.clock.now();
    const due = await this.deletions.listDue({
      now,
      recheckBefore: new Date(now.getTime() - this.policy.recheckMinutes * 60_000),
      limit: this.policy.batchSize,
    });
    const run: AnonymizationRun = { anonymized: [], postponed: [], unchecked: [] };
    for (const userId of due) {
      const obstacles = lastAdminObstacles(await this.deletions.soleAdministeredOrganizations(userId));
      const check = await this.obligations.check(userId);
      if (check.status === 'unavailable') {
        await this.deletions.markChecked(userId, now);
        run.unchecked.push({ userId, services: check.services });
        continue;
      }
      if (check.status === 'blocked') obstacles.push(...check.obstacles);
      if (obstacles.length > 0) {
        await this.deletions.markChecked(userId, now, obstacles);
        run.postponed.push({ userId, obstacles });
        continue;
      }
      if (await this.deletions.anonymize(userId, now)) run.anonymized.push(userId);
    }
    return run;
  }
}
