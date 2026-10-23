export type ClientKind = 'web' | 'mobile' | 'backoffice';

/** Règles des sessions (cahier des charges Identité, partie 4). Valeurs issues de la configuration. */
export interface SessionPolicy {
  /** Durée du jeton de renouvellement (web et mobile : 30 jours ; back-office : 12 heures). */
  refreshTtlSeconds: number;
  /** Sessions simultanées ; au-delà, la plus ancienne est révoquée (web et mobile : 5 ; back-office : 2). */
  maxSessions: number;
  /** Durée prolongée à chaque renouvellement (web et mobile) ; absent : oui. Back-office : non. */
  slidingExpiry?: boolean;
  /** Déconnexion après cette inactivité, mesurée entre deux renouvellements (back-office : 30 minutes). */
  idleTimeoutSeconds?: number;
}

/** Les sessions du back-office et celles des clients ont chacune leurs règles et leur limite. */
export type SessionCategory = 'customer' | 'backoffice';

export function sessionCategory(kind: ClientKind): SessionCategory {
  return kind === 'backoffice' ? 'backoffice' : 'customer';
}

/** Types de client qui partagent la limite de sessions simultanées d'une catégorie. */
export function clientKindsOf(category: SessionCategory): ClientKind[] {
  return category === 'backoffice' ? ['backoffice'] : ['web', 'mobile'];
}

/** Échéance de la session après un renouvellement : prolongée, ou inchangée (back-office). */
export function renewedExpiry(currentExpiry: Date, now: Date, policy: SessionPolicy): Date {
  if (policy.slidingExpiry === false) return currentExpiry;
  return new Date(now.getTime() + policy.refreshTtlSeconds * 1000);
}

/** Session restée inactive trop longtemps (back-office uniquement). */
export function isIdleExpired(lastSeenAt: Date, now: Date, policy: SessionPolicy): boolean {
  if (policy.idleTimeoutSeconds === undefined) return false;
  return now.getTime() - lastSeenAt.getTime() > policy.idleTimeoutSeconds * 1000;
}

export interface ActiveSession {
  id: string;
  lastSeenAt: Date;
}

/**
 * Sessions à révoquer pour qu'une nouvelle session tienne dans la limite :
 * les moins récemment utilisées d'abord.
 */
export function sessionsToRevoke(active: ActiveSession[], maxSessions: number): string[] {
  const excess = active.length + 1 - maxSessions;
  if (excess <= 0) return [];
  return [...active]
    .sort((a, b) => a.lastSeenAt.getTime() - b.lastSeenAt.getTime())
    .slice(0, excess)
    .map((session) => session.id);
}
