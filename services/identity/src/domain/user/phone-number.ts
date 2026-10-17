const E164 = /^\+[1-9][0-9]{6,14}$/;

/**
 * Numéro de téléphone au format international E.164. Tous les pays sont acceptés :
 * la diaspora doit pouvoir s'inscrire avec un numéro étranger.
 */
export class PhoneNumber {
  private constructor(readonly e164: string) {}

  /** Renvoie null si la valeur n'est pas un numéro E.164 (les espaces sont tolérés). */
  static parse(value: string): PhoneNumber | null {
    const compact = value.replace(/\s+/g, '');
    return E164.test(compact) ? new PhoneNumber(compact) : null;
  }

  /** Forme masquée pour l'affichage et les journaux : indicatif et deux derniers chiffres, par exemple +229********45. */
  masked(): string {
    const digits = this.e164.slice(1);
    return `+${digits.slice(0, 3)}${'*'.repeat(digits.length - 5)}${digits.slice(-2)}`;
  }
}
