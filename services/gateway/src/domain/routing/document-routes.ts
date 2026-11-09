import { type RouteDefinition } from './route-manifest';

const DOCUMENT = 'ksp.document.v1.DocumentService';
const SIGNING = 'ksp.document.v1.DocumentSigningService';

/**
 * Routes des documents et de leur signature par code (ADR-044) : lecture par le propriétaire et le
 * signataire connecté, signature depuis l'espace KSP, et signature sans compte par un lien
 * personnel (routes publiques, limitées par adresse IP ; le jeton n'est jamais journalisé).
 * Reprises des extensions x-ksp-* du contrat OpenAPI ; le test de conformité vérifie qu'elles
 * restent identiques.
 */
export const DOCUMENT_ROUTES = [
  {
    operationId: 'getMyDocument',
    method: 'GET',
    path: '/api/v1/document/documents/{id}',
    grpc: `${DOCUMENT}/GetMyDocument`,
    access: { level: 'authenticated' },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'getMyDocumentDownloadUrl',
    method: 'GET',
    path: '/api/v1/document/documents/{id}/download-url',
    grpc: `${DOCUMENT}/CreateMyDownloadUrl`,
    access: { level: 'authenticated' },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'sendDocumentSignatureCode',
    method: 'POST',
    path: '/api/v1/document/signatures/{id}/otp',
    grpc: `${DOCUMENT}/SendSignatureCode`,
    access: { level: 'authenticated' },
    rateLimit: 'document_code_request',
    requiresKnownClient: false,
  },
  {
    operationId: 'signDocument',
    method: 'POST',
    path: '/api/v1/document/signatures/{id}/sign',
    grpc: `${DOCUMENT}/SignDocument`,
    access: { level: 'authenticated' },
    rateLimit: 'document_code_verify',
    requiresKnownClient: false,
  },
  {
    // Publique : la confiance vient du jeton du lien, vérifié par document.
    operationId: 'getSigningSession',
    method: 'GET',
    path: '/api/v1/document/sign/{token}',
    grpc: `${SIGNING}/GetSigningSession`,
    access: { level: 'public' },
    rateLimit: 'document_link',
    requiresKnownClient: false,
  },
  {
    operationId: 'sendSigningCode',
    method: 'POST',
    path: '/api/v1/document/sign/{token}/otp',
    grpc: `${SIGNING}/SendSigningCode`,
    access: { level: 'public' },
    rateLimit: 'document_link_code_request',
    requiresKnownClient: false,
  },
  {
    operationId: 'signWithLink',
    method: 'POST',
    path: '/api/v1/document/sign/{token}/sign',
    grpc: `${SIGNING}/SignWithLink`,
    access: { level: 'public' },
    rateLimit: 'document_link_code_verify',
    requiresKnownClient: false,
  },
] as const satisfies readonly RouteDefinition[];
