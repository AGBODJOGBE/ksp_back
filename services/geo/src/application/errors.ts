import { AppError } from '@ksp/platform';

/** Erreurs du service (contrat gRPC, en-tête de geo.proto). Messages en français, sans coordonnées. */
export const GeoErrors = {
  invalid: (field: string, message: string, details: Record<string, unknown> = {}) =>
    AppError.invalid('GEO_VALIDATION_FAILED', message, { field, ...details }),
  routeNotFound: () => AppError.notFound('GEO_ROUTE_NOT_FOUND', 'Aucun itinéraire ne relie ces points.'),
  pointNotRoutable: (field: string) =>
    AppError.notFound('GEO_POINT_NOT_ROUTABLE', 'Ce point est trop loin du réseau routier.', { field }),
  routingUnavailable: () =>
    AppError.unavailable(
      'GEO_ROUTING_UNAVAILABLE',
      'Le calcul d’itinéraire est momentanément indisponible. Réessayez.',
    ),
};
