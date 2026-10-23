/** Catégories de limites d'appels (extension x-ksp-rate-limits du contrat OpenAPI). */
export type RateLimitCategory =
  'public' | 'authenticated' | 'otp_request' | 'otp_verify' | 'mfa_verify' | 'refresh';

export interface RateLimitRule {
  limit: number;
  windowSeconds: number;
  /** Compteur par adresse IP ou par utilisateur connecté. */
  key: 'ip' | 'user';
}

export type RateLimitTable = Record<RateLimitCategory, RateLimitRule>;

/** Valeurs proposées par le cahier des charges Gateway (partie 4), réglables par configuration. */
export const DEFAULT_RATE_LIMITS: RateLimitTable = {
  public: { limit: 60, windowSeconds: 60, key: 'ip' },
  authenticated: { limit: 300, windowSeconds: 60, key: 'user' },
  otp_request: { limit: 5, windowSeconds: 60, key: 'ip' },
  otp_verify: { limit: 10, windowSeconds: 60, key: 'ip' },
  /** identity limite aussi les essais par jeton de double authentification (5). */
  mfa_verify: { limit: 10, windowSeconds: 60, key: 'ip' },
  refresh: { limit: 60, windowSeconds: 60, key: 'ip' },
};

/** Clé du compteur : une catégorie ne partage jamais ses compteurs avec une autre. */
export function rateLimitKey(
  category: RateLimitCategory,
  rule: RateLimitRule,
  subject: { ip: string; userId?: string },
): string | null {
  if (rule.key === 'user') return subject.userId ? `${category}:user:${subject.userId}` : null;
  return `${category}:ip:${subject.ip}`;
}
