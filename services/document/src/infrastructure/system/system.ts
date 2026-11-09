import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { type Clock, type IdGenerator, type SecretTools } from '../../application/ports';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Identifiants UUID v7 : triables par date de création. */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return uuidv7();
  }
}

/**
 * Secrets du service : codes tirés par un générateur cryptographique ; empreinte HMAC-SHA256 du
 * code liée à son identifiant (clé hors de la base : une fuite de la base ne révèle aucun code) ;
 * jeton du lien de 32 octets aléatoires, gardé par son empreinte SHA-256.
 */
export class NodeSecretTools implements SecretTools {
  constructor(private readonly codeHmacSecret: string) {}

  sha256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
  }

  newCode(length: number): string {
    return String(randomInt(0, 10 ** length)).padStart(length, '0');
  }

  hashCode(codeId: string, code: string): string {
    return createHmac('sha256', this.codeHmacSecret).update(`${codeId}:${code}`).digest('hex');
  }

  codeMatches(codeId: string, code: string, codeHash: string): boolean {
    const expected = Buffer.from(codeHash, 'hex');
    const actual = Buffer.from(this.hashCode(codeId, code), 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  newToken(): string {
    return randomBytes(32).toString('base64url');
  }

  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
