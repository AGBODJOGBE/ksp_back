/**
 * Règles des codes de signature (ADR-044), proches de celles des codes de connexion d'identity :
 * 6 chiffres, 10 minutes, 5 essais par code, un nouveau code au plus toutes les 60 secondes et
 * 5 par heure pour une même demande, 15 essais en tout par demande (ADR-050). Valeurs lues dans la
 * configuration.
 */
export interface CodePolicy {
  length: number;
  ttlSeconds: number;
  maxAttempts: number;
  /** Essais en tout pour une demande, tous codes confondus ; au-delà, la demande est close. */
  maxAttemptsPerRequest: number;
  resendDelaySeconds: number;
  maxPerHour: number;
}

export const DEFAULT_CODE_POLICY: CodePolicy = {
  length: 6,
  ttlSeconds: 600,
  maxAttempts: 5,
  maxAttemptsPerRequest: 15,
  resendDelaySeconds: 60,
  maxPerHour: 5,
};

export type SendDecision =
  { allowed: true } | { allowed: false; reason: 'too_soon' | 'limit_reached'; retryAfterSeconds: number };

const HOUR_MS = 3_600_000;

/** Peut-on envoyer un nouveau code, d'après les dates des codes déjà envoyés pour la demande ? */
export function decideSend(sentAt: readonly Date[], now: Date, policy: CodePolicy): SendDecision {
  const recent = sentAt
    .map((date) => now.getTime() - date.getTime())
    .filter((age) => age >= 0 && age < HOUR_MS)
    .sort((a, b) => a - b);
  if (recent.length === 0) return { allowed: true };
  const sinceLast = recent[0]!;
  if (recent.length >= policy.maxPerHour) {
    const oldest = recent[recent.length - 1]!;
    return {
      allowed: false,
      reason: 'limit_reached',
      retryAfterSeconds: Math.ceil((HOUR_MS - oldest) / 1000),
    };
  }
  const wait = policy.resendDelaySeconds * 1000 - sinceLast;
  if (wait > 0) return { allowed: false, reason: 'too_soon', retryAfterSeconds: Math.ceil(wait / 1000) };
  return { allowed: true };
}

/** Code saisi : chiffres seulement, longueur attendue (espaces tolérés). */
export function normalizeCode(value: string | undefined, length: number): string | null {
  const code = (value ?? '').replace(/\s+/g, '');
  return new RegExp(`^[0-9]{${length}}$`).test(code) ? code : null;
}
