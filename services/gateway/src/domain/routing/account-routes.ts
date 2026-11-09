import { BACKOFFICE_MFA_SECONDS } from './cleaning-routes';
import { type RouteDefinition } from './route-manifest';

const ACCOUNT_ADMIN = 'ksp.identity.v1.AccountAdminService';

/** Recherche de compte au back-office (ADR-029) : rattacher un agent du Nettoyage à son compte KSP. */
const ACCOUNT_LOOKUP = ['cleaning_admin', 'super_admin'] as const;

/**
 * Administration des comptes et des rôles (ADR-043) : la direction, et l'administrateur de chaque
 * métier pour les rôles de son métier (périmètre revérifié par identity).
 */
const ACCOUNT_ADMINS = ['cleaning_admin', 'recovery_admin', 'super_admin'] as const;
/** Suspension, réactivation, réinitialisation de la double authentification : la direction seule. */
const ACCOUNT_MANAGERS = ['super_admin'] as const;

const admins = {
  level: 'authenticated',
  anyRole: ACCOUNT_ADMINS,
  recentMfaSeconds: BACKOFFICE_MFA_SECONDS,
} as const;
const managers = {
  level: 'authenticated',
  anyRole: ACCOUNT_MANAGERS,
  recentMfaSeconds: BACKOFFICE_MFA_SECONDS,
} as const;

/**
 * Routes des comptes au back-office. Reprises des extensions x-ksp-* du contrat OpenAPI ; le test de
 * conformité vérifie qu'elles restent identiques.
 */
export const ACCOUNT_ROUTES = [
  {
    // Numéro dans le corps, jamais dans l'adresse : les adresses des requêtes sont journalisées.
    operationId: 'findAccountByPhone',
    method: 'POST',
    path: '/api/v1/admin/identity/accounts/lookup',
    grpc: `${ACCOUNT_ADMIN}/FindAccountByPhone`,
    access: { level: 'authenticated', anyRole: ACCOUNT_LOOKUP, recentMfaSeconds: BACKOFFICE_MFA_SECONDS },
    rateLimit: 'account_lookup',
    requiresKnownClient: false,
  },
  {
    // Recherche (nom ou numéro) dans le corps, pour la même raison ; même limite contre l'énumération.
    operationId: 'searchAccounts',
    method: 'POST',
    path: '/api/v1/admin/identity/accounts/search',
    grpc: `${ACCOUNT_ADMIN}/SearchAccounts`,
    access: admins,
    rateLimit: 'account_lookup',
    requiresKnownClient: false,
  },
  {
    operationId: 'getAccount',
    method: 'GET',
    path: '/api/v1/admin/identity/accounts/{id}',
    grpc: `${ACCOUNT_ADMIN}/GetAccount`,
    access: admins,
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'listAssignableRoles',
    method: 'GET',
    path: '/api/v1/admin/identity/roles',
    grpc: `${ACCOUNT_ADMIN}/ListAssignableRoles`,
    access: admins,
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'grantAccountRole',
    method: 'POST',
    path: '/api/v1/admin/identity/accounts/{id}/roles',
    grpc: `${ACCOUNT_ADMIN}/GrantAccountRole`,
    access: admins,
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'revokeAccountRole',
    method: 'POST',
    path: '/api/v1/admin/identity/accounts/{id}/roles/revoke',
    grpc: `${ACCOUNT_ADMIN}/RevokeAccountRole`,
    access: admins,
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'suspendAccount',
    method: 'POST',
    path: '/api/v1/admin/identity/accounts/{id}/suspend',
    grpc: `${ACCOUNT_ADMIN}/SuspendAccount`,
    access: managers,
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'reactivateAccount',
    method: 'POST',
    path: '/api/v1/admin/identity/accounts/{id}/reactivate',
    grpc: `${ACCOUNT_ADMIN}/ReactivateAccount`,
    access: managers,
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'resetAccountMfa',
    method: 'POST',
    path: '/api/v1/admin/identity/accounts/{id}/mfa/reset',
    grpc: `${ACCOUNT_ADMIN}/ResetAccountMfa`,
    access: managers,
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
] as const satisfies readonly RouteDefinition[];
