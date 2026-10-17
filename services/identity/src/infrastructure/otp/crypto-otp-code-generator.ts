import { randomInt } from 'node:crypto';
import { type OtpCodeGenerator } from '../../application/otp/otp.ports';

/** Code numérique tiré par un générateur cryptographique, zéros initiaux compris. */
export class CryptoOtpCodeGenerator implements OtpCodeGenerator {
  generate(length: number): string {
    return String(randomInt(0, 10 ** length)).padStart(length, '0');
  }
}
