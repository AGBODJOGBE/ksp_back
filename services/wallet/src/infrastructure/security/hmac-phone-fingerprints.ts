import { createHmac } from 'node:crypto';
import { type PhoneFingerprints } from '../../application/ports';

/**
 * Empreinte d'un numéro (HMAC-SHA256 à clé secrète, en hexadécimal, ADR-048) : sans la clé, elle ne
 * permet pas de retrouver le numéro en essayant tous les numéros béninois.
 */
export class HmacPhoneFingerprints implements PhoneFingerprints {
  constructor(private readonly secret: string) {}

  of(phone: string): string {
    return createHmac('sha256', this.secret).update(phone).digest('hex');
  }
}
