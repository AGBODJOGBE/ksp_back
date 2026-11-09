import { type RouteDefinition } from './route-manifest';

const FILE = 'ksp.file.v1.FileService';

/**
 * Routes du stockage des fichiers (ADR-038) : déclaration d'un envoi (adresse présignée), confirmation,
 * lecture par le propriétaire. Le contenu ne passe jamais par la gateway. Reprises des extensions
 * x-ksp-* du contrat OpenAPI ; le test de conformité vérifie qu'elles restent identiques.
 */
export const FILE_ROUTES = [
  {
    operationId: 'createFileUpload',
    method: 'POST',
    path: '/api/v1/file/uploads',
    grpc: `${FILE}/CreateUpload`,
    access: { level: 'authenticated' },
    rateLimit: 'file_upload',
    requiresKnownClient: false,
  },
  {
    operationId: 'completeFileUpload',
    method: 'POST',
    path: '/api/v1/file/files/{id}/complete',
    grpc: `${FILE}/CompleteUpload`,
    access: { level: 'authenticated' },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'getMyFile',
    method: 'GET',
    path: '/api/v1/file/files/{id}',
    grpc: `${FILE}/GetMyFile`,
    access: { level: 'authenticated' },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
  {
    operationId: 'getMyFileDownloadUrl',
    method: 'GET',
    path: '/api/v1/file/files/{id}/download-url',
    grpc: `${FILE}/CreateMyDownloadUrl`,
    access: { level: 'authenticated' },
    rateLimit: 'authenticated',
    requiresKnownClient: false,
  },
] as const satisfies readonly RouteDefinition[];
