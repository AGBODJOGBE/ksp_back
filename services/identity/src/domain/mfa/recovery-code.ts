/**
 * Codes de récupération (cahier des charges Identité, partie 4 : 10 codes à usage unique remis
 * à l'activation). Seul secours d'un compte interne qui a perdu son téléphone (ADR-023).
 */
export const RECOVERY_CODE_COUNT = 10;

/** Alphabet base32 de Crockford : ni I, ni L, ni O, ni U, pour éviter les confusions à la lecture. */
export const RECOVERY_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 10 caractères de 5 bits : 50 bits d'aléa par code. */
export const RECOVERY_CODE_LENGTH = 10;

/** Présentation remise à l'utilisateur : deux groupes de cinq, par exemple 7KQ2M-X9PDA. */
export function formatRecoveryCode(normalized: string): string {
  return `${normalized.slice(0, 5)}-${normalized.slice(5)}`;
}

/**
 * Forme canonique d'un code saisi : majuscules, sans tiret ni espace, lettres ambiguës lues comme
 * des chiffres (O → 0, I et L → 1). Renvoie null si la saisie ne peut pas être un code.
 */
export function normalizeRecoveryCode(input: string): string | null {
  const normalized = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (normalized.length !== RECOVERY_CODE_LENGTH) return null;
  for (const char of normalized) {
    if (!RECOVERY_CODE_ALPHABET.includes(char)) return null;
  }
  return normalized;
}
