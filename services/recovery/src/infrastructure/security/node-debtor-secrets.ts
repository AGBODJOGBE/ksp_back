import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { type DebtorSecrets } from '../../application/debtor-access/debtor-access.ports';

/**
 * Secrets de l'accès du débiteur (ADR-061) : jetons du lien et de la session de 32 octets aléatoires
 * (base64url, 43 caractères), gardés par leur empreinte SHA-256 ; code de 6 chiffres tiré par un
 * générateur cryptographique, gardé par son empreinte HMAC-SHA256 liée au lien. La clé du HMAC
 * (`RECOVERY_DEBTOR_CODE_HMAC_SECRET`) vient du coffre : une fuite de la base ne révèle aucun code, et
 * le million de codes possibles ne se retrouve pas par force brute sans elle.
 */
export class NodeDebtorSecrets implements DebtorSecrets {
  constructor(private readonly codeHmacSecret: string) {}

  newToken(): string {
    return randomBytes(32).toString('base64url');
  }

  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  newCode(): string {
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
  }

  hashCode(accessId: string, code: string): string {
    return createHmac('sha256', this.codeHmacSecret)
      .update(`recovery-debtor-code:v1:${accessId}:${code}`)
      .digest('hex');
  }

  codeMatches(accessId: string, code: string, hash: string): boolean {
    const expected = Buffer.from(hash, 'hex');
    const actual = Buffer.from(this.hashCode(accessId, code), 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}
