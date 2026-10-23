import { randomBytes } from 'node:crypto';
import { checkTotp, TOTP_DEFAULTS } from '../../domain/mfa/totp';
import { normalizeRecoveryCode } from '../../domain/mfa/recovery-code';
import { AesGcmSecretCipher, MfaEncryptionKeyError } from './aes-gcm-secret-cipher';
import { CryptoMfaTokenGenerator, CryptoRecoveryCodes } from './crypto-mfa-secrets';
import { base32Decode, base32Encode, HmacTotpGenerator } from './hmac-totp-generator';

describe('AesGcmSecretCipher', () => {
  const key = randomBytes(32).toString('base64');

  it('chiffre puis déchiffre (aller-retour), avec un chiffré différent à chaque fois', () => {
    const cipher = AesGcmSecretCipher.fromConfig(key, 'production');
    const first = cipher.encrypt('JBSWY3DPEHPK3PXP', 'user-1');
    const second = cipher.encrypt('JBSWY3DPEHPK3PXP', 'user-1');
    expect(first).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain('JBSWY3DPEHPK3PXP');
    expect(cipher.decrypt(first, 'user-1')).toBe('JBSWY3DPEHPK3PXP');
    // La même clé relue depuis la configuration déchiffre aussi (redémarrage du service).
    expect(AesGcmSecretCipher.fromConfig(key, 'production').decrypt(second, 'user-1')).toBe(
      'JBSWY3DPEHPK3PXP',
    );
  });

  it('refuse un chiffré recopié sur un autre compte, modifié ou lu avec une autre clé', () => {
    const cipher = AesGcmSecretCipher.fromConfig(key, 'production');
    const encrypted = cipher.encrypt('secret', 'user-1');
    expect(() => cipher.decrypt(encrypted, 'user-2')).toThrow();
    const [version, iv, body, tag] = encrypted.split('.');
    const altered = Buffer.from(body!, 'base64url');
    altered[0] = altered[0]! ^ 1;
    expect(() =>
      cipher.decrypt([version, iv, altered.toString('base64url'), tag].join('.'), 'user-1'),
    ).toThrow();
    expect(() => cipher.decrypt([version, iv, body, tag!.slice(0, 8)].join('.'), 'user-1')).toThrow();
    const other = AesGcmSecretCipher.fromConfig(randomBytes(32).toString('base64'), 'production');
    expect(() => other.decrypt(encrypted, 'user-1')).toThrow();
  });

  it('clé obligatoire en production, temporaire ailleurs, 32 octets exigés', () => {
    expect(() => AesGcmSecretCipher.fromConfig(undefined, 'production')).toThrow(MfaEncryptionKeyError);
    expect(AesGcmSecretCipher.fromConfig('', 'development').ephemeral).toBe(true);
    expect(AesGcmSecretCipher.fromConfig(key, 'development').ephemeral).toBe(false);
    expect(() => AesGcmSecretCipher.fromConfig(randomBytes(16).toString('base64'), 'test')).toThrow(
      MfaEncryptionKeyError,
    );
    expect(() => AesGcmSecretCipher.fromConfig('pas-du-base64!', 'test')).toThrow(MfaEncryptionKeyError);
  });
});

describe('HmacTotpGenerator (vecteurs de la RFC 6238, SHA-1)', () => {
  const totp = new HmacTotpGenerator();
  const secret = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

  it('encode le secret de la RFC en base32 et le relit', () => {
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(secret).toString('ascii')).toBe('12345678901234567890');
  });

  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('T = %i → %s', (seconds, expected) => {
    expect(totp.codeAt(secret, Math.floor(seconds / 30), 8)).toBe(expected);
    expect(totp.codeAt(secret, Math.floor(seconds / 30), 6)).toBe(expected.slice(2));
  });

  it('un code calculé est accepté par la règle du domaine, puis refusé s’il est rejoué', () => {
    const generated = totp.generateSecret();
    expect(generated).toMatch(/^[A-Z2-7]{32}$/);
    const now = new Date('2026-10-19T12:00:00Z');
    const step = Math.floor(now.getTime() / 30_000);
    const codeAt = (s: number) => totp.codeAt(generated, s, 6);
    const code = codeAt(step);
    expect(checkTotp({ code, now, parameters: TOTP_DEFAULTS, lastUsedStep: null, codeAt })).toEqual({
      kind: 'valid',
      step,
    });
    expect(checkTotp({ code, now, parameters: TOTP_DEFAULTS, lastUsedStep: step, codeAt }).kind).toBe(
      'reused',
    );
  });
});

describe('CryptoRecoveryCodes et CryptoMfaTokenGenerator', () => {
  it('codes de récupération : forme canonique, aléatoires, empreinte liée au compte', () => {
    const codes = new CryptoRecoveryCodes('secret-hmac-de-test-0123456789abcdef');
    const generated = Array.from({ length: 50 }, () => codes.generate());
    expect(new Set(generated).size).toBe(50);
    for (const code of generated) expect(normalizeRecoveryCode(code)).toBe(code);
    const hash = codes.hash('user-1', generated[0]!);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(codes.hash('user-2', generated[0]!)).not.toBe(hash);
    expect(
      new CryptoRecoveryCodes('autre-secret-de-test-0123456789abcdef').hash('user-1', generated[0]!),
    ).not.toBe(hash);
  });

  it('jeton de double authentification : 256 bits, seule l’empreinte est conservée', () => {
    const tokens = new CryptoMfaTokenGenerator();
    const { token, hash } = tokens.generate();
    expect(token).toMatch(/^[\w-]{43}$/);
    expect(hash).not.toContain(token);
    expect(tokens.hash(token)).toBe(hash);
  });
});
