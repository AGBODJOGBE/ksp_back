import { AppError, fromGrpcError } from '@ksp/platform';

/** Codes produits hors de nos services (réseau, grpc-js, jeton de service) : jamais montrés tels quels. */
const TECHNICAL_CODE = /^(GRPC_|SERVICE_TOKEN_)/;

/**
 * Erreur reçue d'un service, prête pour le front (UC-GW-06, UC-GW-07) :
 * - erreur métier du service (IDENTITY_OTP_EXPIRED…) : transmise telle quelle ;
 * - panne technique : code clair par service (IDENTITY_UNAVAILABLE, IDENTITY_TIMEOUT), message générique,
 *   sans aucun détail interne (nom de méthode, adresse, statut gRPC brut).
 */
export function toUpstreamError(service: string, error: unknown): AppError {
  const appError = fromGrpcError(error);
  if (!TECHNICAL_CODE.test(appError.code)) return appError;
  const prefix = service.toUpperCase();
  switch (appError.kind) {
    case 'UNAVAILABLE':
      return AppError.unavailable(
        `${prefix}_UNAVAILABLE`,
        'Le service est momentanément indisponible, réessayez dans quelques instants.',
      );
    case 'DEADLINE_EXCEEDED':
      return new AppError(
        'DEADLINE_EXCEEDED',
        `${prefix}_TIMEOUT`,
        'Le service met trop de temps à répondre, réessayez dans quelques instants.',
      );
    default:
      return new AppError(
        'INTERNAL',
        'GATEWAY_UPSTREAM_ERROR',
        'Une erreur interne est survenue. Réessayez plus tard.',
      );
  }
}
