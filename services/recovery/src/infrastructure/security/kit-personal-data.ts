import { type BlindIndex, type FieldCipher } from '@ksp/platform';
import { type PersonalData } from '../../application/ports';

/**
 * Coordonnées des débiteurs chiffrées par le kit (ADR-063) : FieldCipher (AES-256-GCM, contexte
 * « table.colonne » en données associées) et BlindIndex (empreinte HMAC par finalité, téléphone
 * normalisé en E.164, +229 à 8 chiffres réécrit +229 01). Deux trousseaux distincts.
 */
export class KitPersonalData implements PersonalData {
  constructor(
    private readonly cipher: FieldCipher,
    private readonly index: BlindIndex,
  ) {}

  encrypt(value: string, context: string): string {
    return this.cipher.encrypt(value, `recovery.${context}`);
  }

  decrypt(value: string, context: string): string {
    return this.cipher.decrypt(value, `recovery.${context}`);
  }

  phoneIndex(phone: string): string {
    return this.index.phone('recovery_debtor_phone', phone);
  }

  emailIndex(email: string): string {
    return this.index.email('recovery_debtor_email', email);
  }
}
