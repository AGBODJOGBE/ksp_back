import { createHmac, randomBytes } from 'node:crypto';
import { type TotpGenerator } from '../../application/mfa/mfa.ports';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 (RFC 4648), sans remplissage : format des secrets lus par les applications d'authentification. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Secret base32 invalide.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * Codes TOTP (RFC 6238) : HOTP (RFC 4226, HMAC-SHA1) sur le pas de temps. Secret de 20 octets
 * (160 bits, taille recommandée par la RFC 4226).
 */
export class HmacTotpGenerator implements TotpGenerator {
  generateSecret(): string {
    return base32Encode(randomBytes(20));
  }

  codeAt(secretBase32: string, step: number, digits: number): string {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const hmac = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
    const offset = hmac[hmac.length - 1]! & 0x0f;
    const binary =
      ((hmac[offset]! & 0x7f) << 24) |
      (hmac[offset + 1]! << 16) |
      (hmac[offset + 2]! << 8) |
      hmac[offset + 3]!;
    return String(binary % 10 ** digits).padStart(digits, '0');
  }
}
