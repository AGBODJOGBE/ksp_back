import { currentContext, type ScopeKind, type UserContext } from '../context/request-context';
import { AppError } from '../errors/app-error';

/**
 * Contrôles d'accès de base, utilisés dans les cas d'usage.
 * La gateway filtre déjà selon le manifeste de routage, mais chaque service revérifie
 * toujours ses propres permissions (cahier des charges Gateway, UC-GW-03).
 */
export function requireUser(): UserContext {
  const user = currentContext()?.user;
  if (!user) throw AppError.unauthenticated('AUTH_REQUIRED', 'Vous devez être connecté.');
  return user;
}

export function hasRole(user: UserContext, role: string, scope?: { type: ScopeKind; id?: string }): boolean {
  return user.roles.some(
    (claim) =>
      claim.role === role &&
      (!scope || (claim.scopeType === scope.type && (scope.id === undefined || claim.scopeId === scope.id))),
  );
}

export function requireRole(role: string, scope?: { type: ScopeKind; id?: string }): UserContext {
  const user = requireUser();
  if (!hasRole(user, role, scope)) {
    throw AppError.forbidden('AUTH_FORBIDDEN', "Vous n'avez pas les droits nécessaires pour cette action.");
  }
  return user;
}

/**
 * Exige une double authentification récente pour les actions sensibles
 * (cahier des charges Identité, partie 4 : moins de 10 minutes par défaut).
 */
export function requireRecentMfa(maxAgeSeconds = 600, now: number = Date.now()): UserContext {
  const user = requireUser();
  const fresh = user.mfa && user.authTime !== undefined && now / 1000 - user.authTime <= maxAgeSeconds;
  if (!fresh) {
    throw AppError.forbidden(
      'AUTH_MFA_REQUIRED',
      'Confirmez votre identité avec la double authentification.',
    );
  }
  return user;
}

/**
 * Permission portée par le jeton (ADR-057, décision 4) : valable partout, ou dans la commune
 * `zoneKey` quand elle est donnée. Jamais d'appel à identity : un changement de rôle s'applique au
 * renouvellement du jeton (15 minutes au plus).
 */
export function hasPermission(user: UserContext, permission: string, zoneKey?: string): boolean {
  if (user.permissions?.includes(permission)) return true;
  return zoneKey !== undefined && (user.zonePermissions?.[zoneKey]?.includes(permission) ?? false);
}

/**
 * Communes où la permission vaut : 'all' (valable partout), ou la liste des clés de commune (vide :
 * nulle part). Sert à filtrer une liste de dossiers sur les zones de l'appelant.
 */
export function permissionZones(user: UserContext, permission: string): 'all' | string[] {
  if (user.permissions?.includes(permission)) return 'all';
  return Object.entries(user.zonePermissions ?? {})
    .filter(([, permissions]) => permissions.includes(permission))
    .map(([zone]) => zone)
    .sort();
}

/** Exige la permission (partout, ou dans `zoneKey`) ; AUTH_FORBIDDEN nomme la permission manquante. */
export function requirePermission(permission: string, zoneKey?: string): UserContext {
  const user = requireUser();
  if (!hasPermission(user, permission, zoneKey)) {
    throw AppError.forbidden('AUTH_FORBIDDEN', "Vous n'avez pas les droits nécessaires pour cette action.", {
      permission,
    });
  }
  return user;
}
