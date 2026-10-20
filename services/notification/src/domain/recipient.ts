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
