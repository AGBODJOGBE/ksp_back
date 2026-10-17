/**
 * Règles des codes de vérification (cahier des charges Identité, partie 4).
 * Les valeurs viennent de la configuration, jamais du code.
 */
export interface OtpPolicy {
  codeLength: number;
  ttlSeconds: number;
  maxAttempts: number;
  /** Délai minimum entre deux envois au même numéro. */
  resendDelaySeconds: number;
  maxPerHour: number;
  maxPerDay: number;
  /** Une fois le plafond journalier atteint, un seul envoi par période de cette durée. */
  blockSeconds: number;
}

export type SendDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

const HOUR = 3600;

/**
 * Décide si un nouveau code peut être envoyé à un numéro, d'après les dates de ses envois réussis
 * des dernières 24 heures. En cas de refus, indique dans combien de secondes réessayer.
 */
export function decideSend(sentAt: Date[], now: Date, policy: OtpPolicy): SendDecision {
  const ages = sentAt
    .map((date) => (now.getTime() - date.getTime()) / 1000)
    .filter((age) => age >= 0 && age < 24 * HOUR)
    .sort((a, b) => a - b);
  if (ages.length === 0) return { allowed: true };

  const sinceLast = ages[0];
  const waits: number[] = [policy.resendDelaySeconds - sinceLast];

  const lastHour = ages.filter((age) => age < HOUR);
  if (lastHour.length >= policy.maxPerHour) {
    // Le plus ancien envoi de l'heure doit sortir de la fenêtre.
    waits.push(HOUR - lastHour[lastHour.length - 1]);
  }
  if (ages.length >= policy.maxPerDay) {
    waits.push(policy.blockSeconds - sinceLast);
  }

  const wait = Math.max(...waits);
  return wait > 0 ? { allowed: false, retryAfterSeconds: Math.ceil(wait) } : { allowed: true };
}
