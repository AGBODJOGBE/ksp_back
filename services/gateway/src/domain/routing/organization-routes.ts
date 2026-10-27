import { BACKOFFICE_MFA_SECONDS } from './cleaning-routes';
import { type RouteDefinition } from './route-manifest';

const AUTH = 'ksp.identity.v1.AuthService';
const ORGANIZATION = 'ksp.identity.v1.OrganizationService';
const ADMIN = 'ksp.identity.v1.OrganizationAdminService';

/** Back-office des comptes entreprise (ADR-027) : décisions réservées à la direction, consultation au support. */
const REVIEWERS = ['super_admin'] as const;
const READERS = ['super_admin', 'support_agent'] as const;

/**
 * Routes des comptes entreprise : changement de contexte, organisations du client, e-mail de
 * facturation, validation au back-office. Reprises des extensions x-ksp-* du contrat OpenAPI ; le
 * test de conformité vérifie qu'elles restent identiques.
 */
export const ORGANIZATION_ROUTES = [
  {
    operationId: 'switchContext',
    method: 'POST',
    path: '/api/v1/identity/context',
    grpc: `${AUTH}/SwitchContext`,
    access: { level: 'authenticated' },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'listMyOrganizations',
    method: 'GET',
    path: '/api/v1/identity/organizations',
    grpc: `${ORGANIZATION}/ListMyOrganizations`,
    access: { level: 'authenticated' },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'createOrganization',
    method: 'POST',
    path: '/api/v1/identity/organizations',
    grpc: `${ORGANIZATION}/CreateOrganization`,
    access: { level: 'authenticated' },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'getMyOrganization',
    method: 'GET',
    path: '/api/v1/identity/organizations/{id}',
    grpc: `${ORGANIZATION}/GetMyOrganization`,
    access: { level: 'authenticated' },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    // Code envoyé par e-mail à l'adresse de facturation ; elle n'est enregistrée qu'à la confirmation.
    operationId: 'changeOrganizationBillingEmail',
    method: 'PUT',
    path: '/api/v1/identity/organizations/{id}/billing-email',
    grpc: `${ORGANIZATION}/ChangeOrganizationBillingEmail`,
    access: { level: 'authenticated' },
    rateLimit: 'email_code_request',
    requiresKnownClient: false,
  },
  {
    operationId: 'confirmOrganizationBillingEmail',
    method: 'POST',
    path: '/api/v1/identity/organizations/{id}/billing-email/verify',
    grpc: `${ORGANIZATION}/ConfirmOrganizationBillingEmail`,
    access: { level: 'authenticated' },
    rateLimit: 'email_code_verify',
    requiresKnownClient: false,
  },
  {
    operationId: 'listOrganizations',
    method: 'GET',
    path: '/api/v1/admin/identity/organizations',
    grpc: `${ADMIN}/ListOrganizations`,
    access: { level: 'authenticated', anyRole: READERS, recentMfaSeconds: BACKOFFICE_MFA_SECONDS },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'getOrganization',
    method: 'GET',
    path: '/api/v1/admin/identity/organizations/{id}',
    grpc: `${ADMIN}/GetOrganization`,
    access: { level: 'authenticated', anyRole: READERS, recentMfaSeconds: BACKOFFICE_MFA_SECONDS },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'validateOrganization',
    method: 'POST',
    path: '/api/v1/admin/identity/organizations/{id}/validate',
    grpc: `${ADMIN}/ValidateOrganization`,
    access: { level: 'authenticated', anyRole: REVIEWERS, recentMfaSeconds: BACKOFFICE_MFA_SECONDS },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'rejectOrganization',
    method: 'POST',
    path: '/api/v1/admin/identity/organizations/{id}/reject',
    grpc: `${ADMIN}/RejectOrganization`,
    access: { level: 'authenticated', anyRole: REVIEWERS, recentMfaSeconds: BACKOFFICE_MFA_SECONDS },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'suspendOrganization',
    method: 'POST',
    path: '/api/v1/admin/identity/organizations/{id}/suspend',
    grpc: `${ADMIN}/SuspendOrganization`,
    access: { level: 'authenticated', anyRole: REVIEWERS, recentMfaSeconds: BACKOFFICE_MFA_SECONDS },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'reactivateOrganization',
    method: 'POST',
    path: '/api/v1/admin/identity/organizations/{id}/reactivate',
    grpc: `${ADMIN}/ReactivateOrganization`,
    access: { level: 'authenticated', anyRole: REVIEWERS, recentMfaSeconds: BACKOFFICE_MFA_SECONDS },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
] as const satisfies readonly RouteDefinition[];
