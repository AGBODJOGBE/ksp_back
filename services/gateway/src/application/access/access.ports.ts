import { type VerifiedAccessToken } from '@ksp/platform';

/** Vérifie un jeton d'accès localement, avec les clés publiques d'identity en cache (UC-GW-02). */
export interface AccessTokenVerifierPort {
  verify(token: string): Promise<VerifiedAccessToken>;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Secondes avant l'ouverture d'une nouvelle fenêtre (au moins 1 quand la limite est atteinte). */
  retryAfterSeconds: number;
}

/**
 * Compteurs des limites d'appels (UC-GW-04). Une seule instance : compteurs en mémoire ;
 * plusieurs répliques : stockage partagé (Redis), derrière ce même port.
 */
export interface RateLimiter {
  consume(key: string, rule: { limit: number; windowSeconds: number }): Promise<RateLimitResult>;
}

export interface Clock {
  now(): Date;
}
