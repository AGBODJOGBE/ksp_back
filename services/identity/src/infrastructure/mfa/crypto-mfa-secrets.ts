import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';
import {
  type MfaTokenGenerator,
  type RecoveryCodeGenerator,
  type RecoveryCodeHasher,
} from '../../application/mfa/mfa.ports';
import { RECOVERY_CODE_ALPHABET, RECOVERY_CODE_LENGTH } from '../../domain/mfa/recovery-code';

/**
 * Codes de récupération : 10 caractères tirés au hasard (50 bits). L'empreinte est un HMAC-SHA256
 * avec une clé hors de la base, liée au compte : une fuite de la base ne permet pas de retrouver
 * les codes par force brute.
 */
export class CryptoRecoveryCodes implements RecoveryCodeGenerator, RecoveryCodeHasher {
  constructor(private readonly secret: string) {}

  generate(): string {
    let code = '';
    for (let index = 0; index < RECOVERY_CODE_LENGTH; index += 1) {
      code += RECOVERY_CODE_ALPHABET[randomInt(RECOVERY_CODE_ALPHABET.length)];
    }
    return code;
  }

  hash(userId: string, normalizedCode: string): string {
    return createHmac('sha256', this.secret).update(`mfa-recovery:${userId}:${normalizedCode}`).digest('hex');
  }
}

/**
 * Jeton de double authentification : 32 octets aléatoires ; seule l'empreinte SHA-256 est
 * conservée (avec 256 bits d'aléa, un hachage lent n'apporterait rien).
 */
export class CryptoMfaTokenGenerator implements MfaTokenGenerator {
  generate(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: this.hash(token) };
  }

  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
