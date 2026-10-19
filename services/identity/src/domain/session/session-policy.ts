export type ClientKind = 'web' | 'mobile' | 'backoffice';

/** Règles des sessions (cahier des charges Identité, partie 4). Valeurs issues de la configuration. */
export interface SessionPolicy {
  /** Durée du jeton de renouvellement, prolongée à chaque usage (web et mobile : 30 jours). */
  refreshTtlSeconds: number;
  /** Sessions simultanées ; au-delà, la plus ancienne est révoquée (web et mobile : 5). */
  maxSessions: number;
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
