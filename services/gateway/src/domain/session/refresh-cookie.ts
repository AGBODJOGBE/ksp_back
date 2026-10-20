/** Chemin du cookie : il n'est envoyé qu'aux routes /api/v1/identity/token/… (contrat OpenAPI). */
export const REFRESH_COOKIE_PATH = '/api/v1/identity/token';

export type BrowserClientKind = 'web' | 'backoffice';

/**
 * Nom du cookie de renouvellement. Le préfixe __Secure- impose l'attribut Secure : sans lui
 * (développement en HTTP hors localhost uniquement), le navigateur refuserait le cookie,
 * d'où un nom sans préfixe.
 */
export function refreshCookieName(kind: BrowserClientKind, secure: boolean): string {
  const base = kind === 'backoffice' ? 'ksp_admin_rt' : 'ksp_rt';
  return secure ? `__Secure-${base}` : base;
}

/** Durée de vie du cookie, alignée sur l'expiration du jeton (arrondie à la seconde inférieure). */
export function refreshCookieMaxAge(expiresAt: Date, now: Date): number {
  return Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
}
