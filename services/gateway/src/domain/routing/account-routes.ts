import { BACKOFFICE_MFA_SECONDS, CRITICAL_MFA_SECONDS } from '../access/mfa-age';
import { type RouteDefinition } from './route-manifest';

const ACCOUNT_ADMIN = 'ksp.identity.v1.AccountAdminService';

/** Recherche de compte au back-office (ADR-029) : rattacher un agent du Nettoyage à son compte KSP. */
const ACCOUNT_LOOKUP = ['cleaning_admin', 'super_admin'] as const;

/**
 * Administration des comptes (ADR-043) : lecture par la direction et par l'administrateur de chaque
 * métier (son équipe, périmètre revérifié par identity). L'attribution et le retrait des rôles sont
 * réservés au super administrateur (CDC Nettoyage v2, partie 2, R-RB-02, 13.3).
 */
const ACCOUNT_ADMINS = ['cleaning_admin', 'recovery_admin', 'super_admin'] as const;
/**
 * Attribution et retrait des rôles (R-RB-02), suspension, réactivation, réinitialisation de la
 * double authentification : la direction seule.
 */
const ACCOUNT_MANAGERS = ['super_admin'] as const;

const admins = {
  level: 'authenticated',
  anyRole: ACCOUNT_ADMINS,
  recentMfaSeconds: BACKOFFICE_MFA_SECONDS,
} as const;
/**
 * Écritures (attribution et retrait des rôles, suspension, double authentification) : super_admin
 * seul, double authentification récente (ADR-050).
 */
const managers = {
  level: 'authenticated',
  anyRole: ACCOUNT_MANAGERS,
  recentMfaSeconds: CRITICAL_MFA_SECONDS,
} as const;

/** Lecture des rôles et des permissions : super_admin, double authentification de la session. */
const roleReaders = {
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
    access: managers,
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'revokeAccountRole',
    method: 'POST',
    path: '/api/v1/admin/identity/accounts/{id}/roles/revoke',
    grpc: `${ACCOUNT_ADMIN}/RevokeAccountRole`,
    access: managers,
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
  // Rôles dynamiques (R-RB-01, R-RB-02 ; ADR-057) : super_admin seul ; lectures avec la double
  // authentification de la session, écritures avec une double authentification récente.
  {
    operationId: 'createRole',
    method: 'POST',
    path: '/api/v1/admin/identity/roles',
    grpc: `${ACCOUNT_ADMIN}/CreateRole`,
    access: managers,
    rateLimit: 'authenticated',
    requiresKnownClient: false,
    successStatus: 201,
  },
  {
    operationId: 'listPermissions',
    method: 'GET',
    path: '/api/v1/admin/identity/permissions',
    grpc: `${ACCOUNT_ADMIN}/ListPermissions`,
    access: roleReaders,
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'getRole',
    method: 'GET',
    path: '/api/v1/admin/identity/roles/{code}',
    grpc: `${ACCOUNT_ADMIN}/GetRole`,
    access: roleReaders,
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'updateRole',
    method: 'PATCH',
    path: '/api/v1/admin/identity/roles/{code}',
    grpc: `${ACCOUNT_ADMIN}/UpdateRole`,
    access: managers,
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'deactivateRole',
    method: 'POST',
    path: '/api/v1/admin/identity/roles/{code}/deactivate',
    grpc: `${ACCOUNT_ADMIN}/DeactivateRole`,
    access: managers,
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
] as const satisfies readonly RouteDefinition[];
