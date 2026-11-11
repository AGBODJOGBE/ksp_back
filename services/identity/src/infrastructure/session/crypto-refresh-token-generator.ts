import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  type RefreshTokenGenerator,
  type RefreshTokenSuccessor,
} from '../../application/session/session.ports';

/** Hachage d'un jeton de renouvellement pour le retrouver en base. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Jeton de renouvellement opaque : 32 octets aléatoires. Seule son empreinte SHA-256 est conservée ;
 * avec 256 bits d'aléa, un hachage lent n'apporterait rien.
 */
export class CryptoRefreshTokenGenerator implements RefreshTokenGenerator {
  generate(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: hashRefreshToken(token) };
  }
}

/**
 * Successeur d'un jeton : HMAC-SHA-256 du jeton, impossible à calculer sans la clé même avec l'ancien
 * jeton. Clé : OTP_HMAC_SECRET, avec une étiquette propre à cet usage.
 */
export class HmacRefreshTokenSuccessor implements RefreshTokenSuccessor {
  constructor(private readonly secret: string) {}

  successor(token: string): { token: string; hash: string } {
    const next = createHmac('sha256', this.secret).update(`refresh-successor:${token}`).digest('base64url');
    return { token: next, hash: hashRefreshToken(next) };
  }
}
