import { type RateLimitCategory } from '../rate-limit/rate-limits';
import { BILLING_ROUTES } from './billing-routes';
import { CLEANING_ROUTES } from './cleaning-routes';
import { ORGANIZATION_ROUTES } from './organization-routes';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Niveau d'accès d'une route (extension x-ksp-access du contrat OpenAPI). */
export type AccessLevel = 'public' | 'refresh_token' | 'mfa_token' | 'authenticated';

/** Exigence d'accès d'une route (UC-GW-03). Le service appelé revérifie toujours ses propres droits. */
export interface AccessRequirement {
  level: AccessLevel;
  /** Au moins un de ces rôles est exigé. */
  anyRole?: readonly string[];
  /** Double authentification datant de moins de ce nombre de secondes. */
  recentMfaSeconds?: number;
}

/** Une ligne du manifeste de routage (cahier des charges Gateway, partie 5). */
export interface RouteDefinition {
  operationId: string;
  method: HttpMethod;
  path: string;
  /** Appel exécuté, sous la forme <paquet>.<Service>/<Méthode> (extension x-ksp-grpc). */
  grpc: string;
  access: AccessRequirement;
  rateLimit: RateLimitCategory;
  /** Route d'authentification : le type de client (web, mobile, back-office) doit être reconnu. */
  requiresKnownClient: boolean;
  /** Écriture sensible : en-tête Idempotency-Key obligatoire, transmis au service. */
  idempotencyKey?: 'required';
}

const IDENTITY_AUTH = 'ksp.identity.v1.AuthService';
const IDENTITY_ACCOUNT = 'ksp.identity.v1.AccountService';

/**
 * Manifeste de routage versionné avec le code : une route absente d'ici n'existe pas.
 * Il reprend les extensions x-ksp-* du contrat contracts/openapi/ksp-api.v1.yaml, et un test
 * vérifie que les deux restent identiques.
 */
export const ROUTE_MANIFEST = [
  {
    operationId: 'requestOtp',
    method: 'POST',
    path: '/api/v1/identity/otp/request',
    grpc: `${IDENTITY_AUTH}/RequestOtp`,
    access: { level: 'public' },
    rateLimit: 'otp_request',
    requiresKnownClient: true,
  },
  {
    operationId: 'verifyOtp',
    method: 'POST',
    path: '/api/v1/identity/otp/verify',
    grpc: `${IDENTITY_AUTH}/VerifyOtp`,
    access: { level: 'public' },
    rateLimit: 'otp_verify',
    requiresKnownClient: true,
  },
  {
    // Jeton de double authentification dans le corps : identity le vérifie (UC-ID-09).
    operationId: 'enrollTotp',
    method: 'POST',
    path: '/api/v1/identity/mfa/totp/enroll',
    grpc: `${IDENTITY_AUTH}/EnrollTotp`,
    access: { level: 'mfa_token' },
    rateLimit: 'mfa_verify',
    requiresKnownClient: true,
  },
  {
    operationId: 'confirmTotp',
    method: 'POST',
    path: '/api/v1/identity/mfa/totp/confirm',
    grpc: `${IDENTITY_AUTH}/ConfirmTotp`,
    access: { level: 'mfa_token' },
    rateLimit: 'mfa_verify',
    requiresKnownClient: true,
  },
  {
    operationId: 'verifyMfa',
    method: 'POST',
    path: '/api/v1/identity/mfa/verify',
    grpc: `${IDENTITY_AUTH}/VerifyMfa`,
    access: { level: 'mfa_token' },
    rateLimit: 'mfa_verify',
    requiresKnownClient: true,
  },
  {
    operationId: 'refreshSession',
    method: 'POST',
    path: '/api/v1/identity/token/refresh',
    grpc: `${IDENTITY_AUTH}/RefreshSession`,
    access: { level: 'refresh_token' },
    rateLimit: 'refresh',
    requiresKnownClient: true,
  },
  {
    operationId: 'logout',
    method: 'POST',
    path: '/api/v1/identity/logout',
    grpc: `${IDENTITY_AUTH}/Logout`,
    access: { level: 'authenticated' },
    rateLimit: 'authenticated',
    requiresKnownClient: true,
  },
  {
    operationId: 'getMe',
    method: 'GET',
    path: '/api/v1/identity/me',
    grpc: `${IDENTITY_ACCOUNT}/GetMe`,
    access: { level: 'authenticated' },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'updateMe',
    method: 'PATCH',
    path: '/api/v1/identity/me',
    grpc: `${IDENTITY_ACCOUNT}/UpdateMe`,
    access: { level: 'authenticated' },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    // Code envoyé par e-mail à la nouvelle adresse ; elle n'est enregistrée qu'à la confirmation.
    operationId: 'changeEmail',
    method: 'PUT',
    path: '/api/v1/identity/me/email',
    grpc: `${IDENTITY_ACCOUNT}/ChangeEmail`,
    access: { level: 'authenticated' },
    rateLimit: 'email_code_request',
    requiresKnownClient: false,
  },
  {
    operationId: 'confirmEmail',
    method: 'POST',
    path: '/api/v1/identity/me/email/verify',
    grpc: `${IDENTITY_ACCOUNT}/ConfirmEmail`,
    access: { level: 'authenticated' },
    rateLimit: 'email_code_verify',
    requiresKnownClient: false,
  },
  {
    // Clés servies depuis le cache de la gateway, alimenté par le JWKS HTTP d'identity (ADR-020) ;
    // l'appel gRPC déclaré par le contrat est la source logique de ce document.
    operationId: 'getJwks',
    method: 'GET',
    path: '/.well-known/jwks.json',
    grpc: `${IDENTITY_AUTH}/GetSigningKeys`,
    access: { level: 'public' },
    rateLimit: 'public',
    requiresKnownClient: false,
  },
  ...ORGANIZATION_ROUTES,
  ...CLEANING_ROUTES,
  ...BILLING_ROUTES,
] as const satisfies readonly RouteDefinition[];

export type OperationId = (typeof ROUTE_MANIFEST)[number]['operationId'];

export function findRoute(operationId: string): RouteDefinition | undefined {
  return (ROUTE_MANIFEST as readonly RouteDefinition[]).find((route) => route.operationId === operationId);
}
