import { AppError, requireUser } from '@ksp/platform';
import { normalizeReason } from '../../domain/organization/organization';
import { defaultAssignmentScope, type RoleDefinition } from '../../domain/role/role';
import {
  ACCOUNT_ADMIN_ROLES,
  type AccountAction,
  accountTransition,
  type AdminPerimeter,
  canManageAccounts,
  canManageRole,
  isAssignableScope,
  parseAccountQuery,
  perimeterOf,
  seesFullPhone,
} from '../../domain/role/role-administration';
import { PhoneNumber } from '../../domain/user/phone-number';
import { isUuid } from '../context/active-contexts';
import { requireStaff } from '../organization/organization-admin.use-cases';
import {
  LastSuperAdminError,
  RoleAssignmentNotFoundError,
  RoleAssignmentRevokedError,
  type RoleRepository,
} from '../role/role.ports';
import { type Clock, type IdGenerator } from '../shared/system.ports';
import { accountAdminErrors } from './account-admin-errors';
import {
  type AccountAdminRepository,
  type AccountAuditView,
  AccountStatusChangedError,
  type AdminAccountView,
  type MfaStatusView,
  type RoleAssignmentView,
} from './account-admin.ports';

/**
 * Administration des comptes et des rôles au back-office (ADR-043, UC-ID-18 à 20). La gateway filtre
 * déjà selon son manifeste ; identity revérifie toujours le rôle, la double authentification faite
 * pendant la session du back-office et le périmètre de l'appelant.
 */

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const HISTORY_SIZE = 50;

export interface AccountAdminActor {
  actorId: string;
  perimeter: AdminPerimeter;
}

const forbidden = () =>
  AppError.forbidden('AUTH_FORBIDDEN', "Vous n'avez pas les droits nécessaires pour cette action.");

/** Administrateur des comptes (super_admin ou administrateur de métier), avec son périmètre. */
export function requireAccountAdmin(): AccountAdminActor {
  const actorId = requireStaff(ACCOUNT_ADMIN_ROLES);
  const perimeter = perimeterOf(requireUser().roles.map((claim) => claim.role));
  if (!perimeter) throw forbidden();
  return { actorId, perimeter };
}

/** Compte présenté à l'appelant : numéro complet pour super_admin, masqué pour tous. */
export interface AdminAccountOutput extends Omit<AdminAccountView, 'phoneE164'> {
  phoneE164: string | null;
  phoneMasked: string | null;
}

function present(account: AdminAccountView, perimeter: AdminPerimeter): AdminAccountOutput {
  const phone = account.phoneE164 ? PhoneNumber.parse(account.phoneE164) : null;
  return {
    ...account,
    phoneE164: seesFullPhone(perimeter) ? account.phoneE164 : null,
    phoneMasked: phone?.masked() ?? null,
  };
}

export interface AccountActions {
  grantRole: boolean;
  suspend: boolean;
  reactivate: boolean;
  resetMfa: boolean;
}

export interface AccountDetailView {
  account: AdminAccountOutput;
  mfa: MfaStatusView;
  roles: (RoleAssignmentView & { revocable: boolean })[];
  history: AccountAuditView[];
  actions: AccountActions;
}

function reasonOf(value: string | undefined): string {
  const reason = normalizeReason(value ?? '');
  if (!reason) throw accountAdminErrors.reasonRequired();
  return reason;
}

/** Fiche d'un compte vue par un administrateur : lue après chaque écriture. */
export class AccountDetails {
  constructor(private readonly accounts: AccountAdminRepository) {}

  /** Compte existant et non supprimé ; IDENTITY_USER_NOT_FOUND sinon. */
  async account(userId: string): Promise<AdminAccountView> {
    const account = isUuid(userId) ? await this.accounts.findAccount(userId) : null;
    if (!account || account.status === 'deleted') throw accountAdminErrors.notFound();
    return account;
  }

  async load(userId: string, actor: AccountAdminActor): Promise<AccountDetailView> {
    const account = await this.account(userId);
    const [assignments, history, mfa, catalog] = await Promise.all([
      this.accounts.assignments(account.id),
      this.accounts.history(account.id, HISTORY_SIZE),
      this.accounts.mfaStatus(account.id),
      this.accounts.catalog(),
    ]);
    const manages = canManageAccounts(actor.perimeter);
    const self = account.id === actor.actorId;
    return {
      account: present(account, actor.perimeter),
      mfa,
      roles: assignments.map((assignment) => ({
        ...assignment,
        revocable: assignment.revokedAt === null && canManageRole(actor.perimeter, assignment.role),
      })),
      history,
      actions: {
        grantRole:
          account.status === 'active' && catalog.some((role) => canManageRole(actor.perimeter, role)),
        suspend: manages && !self && accountTransition(account.status, 'suspend') !== null,
        reactivate: manages && accountTransition(account.status, 'reactivate') !== null,
        resetMfa: manages && !self && mfa.resettable,
      },
    };
  }
}

/**
 * Recherche de comptes. Un administrateur de métier ne voit que son équipe (comptes qui ont un rôle
 * actif de son métier), sauf par un numéro complet, qu'il connaît déjà (ADR-029).
 */
export class SearchAccountsUseCase {
  constructor(private readonly accounts: AccountAdminRepository) {}

  async execute(input: {
    query: string;
    limit: number;
    cursor: string;
  }): Promise<{ items: AdminAccountOutput[]; nextCursor: string | null }> {
    const actor = requireAccountAdmin();
    const query = parseAccountQuery(input.query);
    if (!query) {
      throw accountAdminErrors.invalid(
        'query',
        'Saisissez au moins 2 lettres du nom, ou le numéro complet au format international (+229…).',
      );
    }
    const team = actor.perimeter.kind === 'all' ? null : actor.perimeter.services;
    const limit = input.limit > 0 ? Math.min(input.limit, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
    // Un curseur illisible repart du début : il ne vient que d'une page précédente.
    const cursor = input.cursor && isUuid(input.cursor) ? input.cursor : null;
    const page = await this.accounts.search({
      query,
      teamOf: query.kind === 'phone' ? null : team,
      limit,
      cursor,
    });
    return { items: page.items.map((item) => present(item, actor.perimeter)), nextCursor: page.nextCursor };
  }
}

export class GetAccountUseCase {
  constructor(private readonly details: AccountDetails) {}

  execute(userId: string): Promise<AccountDetailView> {
    return this.details.load(userId, requireAccountAdmin());
  }
}

/** Catalogue des rôles, avec ceux que l'appelant peut attribuer. */
export class ListAssignableRolesUseCase {
  constructor(private readonly accounts: AccountAdminRepository) {}

  async execute(): Promise<(RoleDefinition & { grantable: boolean })[]> {
    const actor = requireAccountAdmin();
    const catalog = await this.accounts.catalog();
    return catalog
      .map((role) => ({ ...role, grantable: canManageRole(actor.perimeter, role) }))
      .sort((a, b) => a.service.localeCompare(b.service) || a.code.localeCompare(b.code));
  }
}

/**
 * Attribuer un rôle du catalogue à un compte actif, avec la portée du rôle (globale, ou son métier).
 * Une attribution active identique est rendue telle quelle.
 */
export class GrantAccountRoleUseCase {
  constructor(
    private readonly details: AccountDetails,
    private readonly roles: RoleRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(input: { userId: string; roleCode: string; reason?: string }): Promise<AccountDetailView> {
    const actor = requireAccountAdmin();
    const reason = reasonOf(input.reason);
    const account = await this.details.account(input.userId);
    const role = await this.roles.findDefinition(input.roleCode);
    if (!role) throw accountAdminErrors.roleNotFound();
    const scope = isAssignableScope(role.scopeType) ? defaultAssignmentScope(role) : null;
    if (!scope) throw accountAdminErrors.scopeInvalid();
    if (!canManageRole(actor.perimeter, role)) throw accountAdminErrors.roleForbidden();
    if (account.status !== 'active') throw accountAdminErrors.notActive(account.status);

    await this.roles.grant({
      assignmentId: this.ids.next(),
      userId: account.id,
      roleCode: role.code,
      ...scope,
      grantedBy: actor.actorId,
      now: this.clock.now(),
      audit: { id: this.ids.next(), reason },
    });
    return this.details.load(account.id, actor);
  }
}

/** Retirer un rôle ; jamais le dernier super_admin d'un compte actif. */
export class RevokeAccountRoleUseCase {
  constructor(
    private readonly details: AccountDetails,
    private readonly accounts: AccountAdminRepository,
    private readonly roles: RoleRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    userId: string;
    assignmentId: string;
    reason?: string;
  }): Promise<AccountDetailView> {
    const actor = requireAccountAdmin();
    const reason = reasonOf(input.reason);
    const account = await this.details.account(input.userId);
    const assignment = isUuid(input.assignmentId)
      ? (await this.accounts.assignments(account.id)).find((item) => item.id === input.assignmentId)
      : undefined;
    if (!assignment) throw accountAdminErrors.assignmentNotFound();
    if (!canManageRole(actor.perimeter, assignment.role)) throw accountAdminErrors.roleForbidden();
    if (assignment.revokedAt) throw accountAdminErrors.alreadyRevoked();

    try {
      await this.roles.revoke({
        assignmentId: assignment.id,
        userId: account.id,
        actorId: actor.actorId,
        reason,
        auditId: this.ids.next(),
        now: this.clock.now(),
      });
    } catch (error) {
      if (error instanceof RoleAssignmentNotFoundError) throw accountAdminErrors.assignmentNotFound();
      if (error instanceof RoleAssignmentRevokedError) throw accountAdminErrors.alreadyRevoked();
      if (error instanceof LastSuperAdminError) throw accountAdminErrors.lastSuperAdmin();
      throw error;
    }
    return this.details.load(account.id, actor);
  }
}

/** Réservé à super_admin : suspension, réactivation, réinitialisation de la double authentification. */
function requireAccountManager(): AccountAdminActor {
  const actor = requireAccountAdmin();
  if (!canManageAccounts(actor.perimeter)) throw forbidden();
  return actor;
}

/**
 * Suspendre (toutes les sessions fermées) ou réactiver un compte, avec un motif. Personne ne
 * suspend son propre compte, ni le dernier super administrateur actif.
 */
export class ChangeAccountStatusUseCase {
  constructor(
    private readonly details: AccountDetails,
    private readonly accounts: AccountAdminRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    userId: string;
    action: AccountAction;
    reason?: string;
  }): Promise<AccountDetailView> {
    const actor = requireAccountManager();
    const reason = reasonOf(input.reason);
    const account = await this.details.account(input.userId);
    if (input.action === 'suspend' && account.id === actor.actorId) throw accountAdminErrors.selfAction();
    const to = accountTransition(account.status, input.action);
    if (!to) throw accountAdminErrors.invalidTransition(account.status, input.action);

    try {
      await this.accounts.changeStatus({
        userId: account.id,
        action: input.action,
        from: account.status,
        to,
        actorId: actor.actorId,
        reason,
        auditId: this.ids.next(),
        now: this.clock.now(),
      });
    } catch (error) {
      if (error instanceof LastSuperAdminError) throw accountAdminErrors.lastSuperAdmin();
      if (!(error instanceof AccountStatusChangedError)) throw error;
      // Une autre décision est passée entre-temps : on signale l'état réel.
      const current = await this.accounts.findAccount(account.id);
      throw accountAdminErrors.invalidTransition(current?.status ?? account.status, input.action);
    }
    return this.details.load(account.id, actor);
  }
}

/**
 * Téléphone perdu (UC-ID-18, ADR-023) : efface l'application d'authentification et les codes de
 * récupération ; la prochaine connexion au back-office impose une nouvelle configuration.
 */
export class ResetAccountMfaUseCase {
  constructor(
    private readonly details: AccountDetails,
    private readonly accounts: AccountAdminRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(input: { userId: string; reason?: string }): Promise<AccountDetailView> {
    const actor = requireAccountManager();
    const reason = reasonOf(input.reason);
    const account = await this.details.account(input.userId);
    if (account.id === actor.actorId) throw accountAdminErrors.selfAction();
    const reset = await this.accounts.resetMfa({
      userId: account.id,
      actorId: actor.actorId,
      reason,
      auditId: this.ids.next(),
      now: this.clock.now(),
    });
    if (!reset) throw accountAdminErrors.mfaNotEnrolled();
    return this.details.load(account.id, actor);
  }
}
