import { addDaysToInstant } from './calendar';
import { type CaseStatus } from './case';
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

/**
 * Le débiteur n'accède qu'à un dossier en cours de recouvrement : actif, ou suspendu par sa
 * contestation. Sinon son lien et sa session ne valent plus rien (dossier clos, refusé).
 */
export function isOpenToDebtor(status: CaseStatus): boolean {
  return status === 'active' || status === 'suspended';
}

/**
 * Accès en lecture seule après la clôture : 30 jours par défaut (réglable, 0 : aucun), le temps pour le
 * débiteur de télécharger son attestation de solde et ses reçus (R-DB-03).
 */
export const DEFAULT_CLOSED_ACCESS_DAYS = 30;

/** Accès complet (dossier en cours) ou lecture seule de ses documents (dossier clos depuis peu). */
export type DebtorAccessMode = 'full' | 'read_only';

/** Fin de l'accès en lecture seule d'un dossier clos ; null s'il n'y en a pas (0 jour). */
export function closedAccessEnd(closedAt: Date, closedAccessDays: number): Date | null {
  return closedAccessDays > 0 ? addDaysToInstant(closedAt, closedAccessDays) : null;
}

/**
 * Accès du débiteur selon son dossier : complet pour un dossier actif ou suspendu ; en lecture seule
 * (attestation de solde et reçus, ni paiement, ni contestation, ni pièce) pendant N jours après la
 * clôture ; aucun sinon (dossier refusé, clos depuis plus longtemps, date de clôture inconnue).
 */
export function debtorAccessMode(
  status: CaseStatus,
  closedAt: Date | null,
  now: Date,
  closedAccessDays: number,
): DebtorAccessMode | null {
  if (isOpenToDebtor(status)) return 'full';
  if (status !== 'closed' || closedAt === null) return null;
  const end = closedAccessEnd(closedAt, closedAccessDays);
  return end !== null && now < end ? 'read_only' : null;
}

/** Échéance d'un code envoyé maintenant (`debtorCodeMinutes`, 10 — `FIXED_RULES`). */
export function codeExpiry(now: Date, debtorCodeMinutes: number): Date {
  return new Date(now.getTime() + debtorCodeMinutes * 60_000);
}

/** Un code se compare s'il existe et n'a pas expiré ; sinon `RECOVERY_DEBTOR_CODE_EXPIRED`. */
export function isCodeValid(code: { expiresAt: Date } | null, now: Date): boolean {
  return code !== null && now < code.expiresAt;
}

/**
 * Secondes avant qu'un nouveau code puisse partir (un par minute : `RECOVERY_DEBTOR_CODE_TOO_SOON`,
 * `retryAfterSeconds`), 0 s'il peut partir maintenant.
 */
export function codeResendWait(lastSentAt: Date | null, now: Date, resendSeconds: number): number {
  if (lastSentAt === null) return 0;
  const waitMs = lastSentAt.getTime() + resendSeconds * 1000 - now.getTime();
  return waitMs > 0 ? Math.ceil(waitMs / 1000) : 0;
}
