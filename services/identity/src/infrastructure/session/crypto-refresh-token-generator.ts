import { createHash, randomBytes } from 'node:crypto';
import { type RefreshTokenGenerator } from '../../application/session/session.ports';

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
