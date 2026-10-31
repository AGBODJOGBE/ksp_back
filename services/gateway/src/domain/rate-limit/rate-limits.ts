/** Catégories de limites d'appels (extension x-ksp-rate-limits du contrat OpenAPI). */
export type RateLimitCategory =
  | 'public'
  | 'authenticated'
  | 'otp_request'
  | 'otp_verify'
  | 'mfa_verify'
  | 'refresh'
  | 'cleaning_simulation'
  | 'email_code_request'
  | 'email_code_verify'
  | 'account_lookup'
  | 'payment_create'
  | 'payment_webhook';

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
  // Simulateur public du Nettoyage (cahier des charges Nettoyage, partie 5).
  cleaning_simulation: { limit: 20, windowSeconds: 60, key: 'ip' },
  // Code de confirmation de l'e-mail du profil : identity limite aussi par adresse et par compte.
  email_code_request: { limit: 3, windowSeconds: 60, key: 'user' },
  email_code_verify: { limit: 10, windowSeconds: 60, key: 'user' },
  // Recherche de compte par téléphone au back-office (ADR-029) : freine l'énumération des numéros.
  account_lookup: { limit: 20, windowSeconds: 60, key: 'user' },
  // Création d'un paiement en ligne (ADR-031) : chaque création peut appeler le prestataire.
  payment_create: { limit: 10, windowSeconds: 60, key: 'user' },
  // Notifications du prestataire de paiement (route publique, signature vérifiée par payment).
  payment_webhook: { limit: 120, windowSeconds: 60, key: 'ip' },
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
