import { tryNormalizePhone } from '@ksp/platform/phone';

/**
 * Numéro de téléphone au format international E.164. Tous les pays sont acceptés :
 * la diaspora doit pouvoir s'inscrire avec un numéro étranger.
 * Normalisation commune du kit (ADR-063) : un numéro béninois `+229` à 8 chiffres devient
 * `+229 01` suivi des 8 chiffres, pour que les deux formes donnent le même compte.
 */
export class PhoneNumber {
  private constructor(readonly e164: string) {}

  /** Renvoie null si la valeur n'est pas un numéro E.164 (espaces, points, tirets et `00` tolérés). */
  static parse(value: string): PhoneNumber | null {
    const normalized = tryNormalizePhone(value);
    return normalized === null ? null : new PhoneNumber(normalized);
  }

  /** Forme masquée pour l'affichage et les journaux : indicatif et deux derniers chiffres, par exemple +229********45. */
  masked(): string {
    const digits = this.e164.slice(1);
    return `+${digits.slice(0, 3)}${'*'.repeat(digits.length - 5)}${digits.slice(-2)}`;
  }
}
