const E164 = /^\+[1-9][0-9]{6,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Numéro de téléphone au format international E.164 (tous les pays : la diaspora en fait partie). */
export class PhoneNumber {
  private constructor(readonly e164: string) {}

  /** Renvoie null si la valeur n'est pas un numéro E.164 (les espaces sont tolérés). */
  static parse(value: string): PhoneNumber | null {
    const compact = value.replace(/\s+/g, '');
    return E164.test(compact) ? new PhoneNumber(compact) : null;
  }

  /**
   * Forme masquée, seule conservée en base et dans les événements : indicatif et deux derniers
   * chiffres, par exemple +229********45 (même forme que dans identity.otp.requested).
   */
  masked(): string {
    const digits = this.e164.slice(1);
    return `+${digits.slice(0, 3)}${'*'.repeat(digits.length - 5)}${digits.slice(-2)}`;
  }
}

/** Identifiant de compte du destinataire : vide pour une personne sans compte, sinon un UUID. */
export function parseRecipientUserId(value: string): { valid: boolean; userId: string | null } {
  const trimmed = value.trim();
  if (!trimmed) return { valid: true, userId: null };
  return UUID.test(trimmed) ? { valid: true, userId: trimmed.toLowerCase() } : { valid: false, userId: null };
}

/** Forme volontairement simple : une partie locale, un @, un domaine avec au moins un point. */
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;

/** Adresse e-mail d'un destinataire. */
export class EmailAddress {
  private constructor(readonly value: string) {}

  /** Renvoie null si la valeur n'est pas une adresse e-mail plausible (espaces retirés, minuscules). */
  static parse(value: string | null | undefined): EmailAddress | null {
    const compact = (value ?? '').trim().toLowerCase();
    return compact.length <= 254 && EMAIL.test(compact) ? new EmailAddress(compact) : null;
  }

  /**
   * Forme masquée, seule conservée en base, dans les événements et les journaux : première lettre
   * de la partie locale et domaine, par exemple k***@exemple.com.
   */
  masked(): string {
    const at = this.value.lastIndexOf('@');
    return `${this.value.slice(0, 1)}***${this.value.slice(at)}`;
  }
}
