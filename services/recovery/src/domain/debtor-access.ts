import { addDaysToInstant } from './calendar';
import { type Outcome, refusal, success } from './outcome';

/**
 * Accès du débiteur sans compte (partie 7, 17.3 ; ADR-061) : un lien personnel valable 30 jours,
 * renouvelé à chaque relance ; un code envoyé au téléphone du débiteur à chaque ouverture ; 5 codes
 * faux bloquent l'accès une heure ; puis une session courte (30 minutes). Jetons et codes sont tirés et
 * hachés par l'infrastructure : le domaine ne règle que les durées et les compteurs.
 */
export interface DebtorLink {
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface CodeAttempts {
  failures: number;
  lockedUntil: Date | null;
}

export const NO_ATTEMPTS: CodeAttempts = { failures: 0, lockedUntil: null };

/** Nouveau lien, ou lien renouvelé à une relance (l'ancien jeton est révoqué). */
export function issueLink(now: Date, debtorLinkDays: number): DebtorLink {
  return { issuedAt: now, expiresAt: addDaysToInstant(now, debtorLinkDays), revokedAt: null };
}

/**
 * Un lien ouvre l'accès s'il n'est ni révoqué (dossier clos, jeton remplacé) ni expiré. Sinon
 * `RECOVERY_DEBTOR_LINK_INVALID` (404), sans dire pourquoi : un jeton inconnu répond pareil.
 */
export function checkLink(link: DebtorLink, now: Date): Outcome<DebtorLink> {
  if (link.revokedAt !== null || now >= link.expiresAt) {
    return refusal('RECOVERY_DEBTOR_LINK_INVALID', 'Lien inconnu ou expiré');
  }
  return success(link);
}

export function isLocked(attempts: CodeAttempts, now: Date): boolean {
  return attempts.lockedUntil !== null && now < attempts.lockedUntil;
}

/** Avant de vérifier un code : `RECOVERY_DEBTOR_LOCKED` pendant le blocage (`retryAfterSeconds`). */
export function checkAttemptAllowed(attempts: CodeAttempts, now: Date): Outcome<CodeAttempts> {
  if (isLocked(attempts, now))
    return refusal('RECOVERY_DEBTOR_LOCKED', 'Trop d’essais : réessayez plus tard');
  // Le blocage écoulé remet le compteur à zéro.
  return success(attempts.lockedUntil !== null ? NO_ATTEMPTS : attempts);
}

/** Secondes avant la fin du blocage, 0 sans blocage. */
export function retryAfterSeconds(attempts: CodeAttempts, now: Date): number {
  if (attempts.lockedUntil === null || now >= attempts.lockedUntil) return 0;
  return Math.ceil((attempts.lockedUntil.getTime() - now.getTime()) / 1000);
}

/** Essais restants avant blocage (`attemptsLeft` de `RECOVERY_DEBTOR_CODE_INVALID`). */
export function attemptsLeft(attempts: CodeAttempts, maxAttempts: number): number {
  return Math.max(0, maxAttempts - attempts.failures);
}

/** Code faux : un essai de plus ; au N-ième (5), blocage de M minutes (60) — `FIXED_RULES`. */
export function registerFailure(
  attempts: CodeAttempts,
  now: Date,
  options: { maxAttempts: number; lockMinutes: number },
): CodeAttempts {
  const failures = attempts.failures + 1;
  if (failures < options.maxAttempts) return { failures, lockedUntil: null };
  return { failures, lockedUntil: new Date(now.getTime() + options.lockMinutes * 60_000) };
}

/** Code juste : le compteur repart de zéro. */
export function registerSuccess(): CodeAttempts {
  return NO_ATTEMPTS;
}

/** Fin d'une session ouverte par un code juste (`debtorSessionMinutes`, 30). */
export function sessionExpiry(now: Date, debtorSessionMinutes: number): Date {
  return new Date(now.getTime() + debtorSessionMinutes * 60_000);
}
