import { createHmac, timingSafeEqual } from 'node:crypto';
import { type OtpHasher } from '../../application/otp/otp.ports';

/**
 * Empreinte HMAC-SHA256 du code, liée à sa demande : le même code donne une empreinte différente
 * pour chaque demande. Sans la clé secrète (hors de la base), une fuite de la base ne révèle rien.
 */
export class HmacOtpHasher implements OtpHasher {
  constructor(private readonly secret: string) {}

  hash(challengeId: string, code: string): string {
    return createHmac('sha256', this.secret).update(`${challengeId}:${code}`).digest('hex');
  }

  matches(challengeId: string, code: string, codeHash: string): boolean {
    const expected = Buffer.from(codeHash, 'hex');
    const actual = Buffer.from(this.hash(challengeId, code), 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}
