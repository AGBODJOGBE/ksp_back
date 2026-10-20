/** Type de client, qui fixe les règles de session d'identity et le transport du jeton de renouvellement. */
export type ClientKind = 'web' | 'mobile' | 'backoffice';

/** Origines autorisées pour l'environnement (UC-GW-14). */
export interface ClientOrigins {
  /** Portail, shop, print. */
  web: readonly string[];
  backoffice: readonly string[];
}

/**
 * Déduit le type de client, jamais déclaré par le client lui-même (contrat OpenAPI) :
 * - origine du back-office : back-office ; origine d'un site : web ;
 * - aucune origine et en-tête X-App-Version présent : application mobile ;
 * - sinon : inconnu.
 */
export function resolveClientKind(
  request: { origin?: string | undefined; appVersion?: string | undefined },
  origins: ClientOrigins,
): ClientKind | null {
  if (request.origin !== undefined) {
    if (origins.backoffice.includes(request.origin)) return 'backoffice';
    if (origins.web.includes(request.origin)) return 'web';
    return null;
  }
  return request.appVersion?.trim() ? 'mobile' : null;
}

/** Où voyage le jeton de renouvellement : cookie HttpOnly dans un navigateur, corps sur mobile (UC-GW-13). */
export function refreshTokenTransport(kind: ClientKind): 'cookie' | 'body' {
  return kind === 'mobile' ? 'body' : 'cookie';
}
