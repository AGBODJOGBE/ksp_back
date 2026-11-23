import { randomBytes } from 'node:crypto';
import { FieldCipher, FieldKeyError } from '@ksp/platform';
import { checkTotp, TOTP_DEFAULTS } from '../../domain/mfa/totp';
import { normalizeRecoveryCode } from '../../domain/mfa/recovery-code';
import { CryptoMfaTokenGenerator, CryptoRecoveryCodes } from './crypto-mfa-secrets';
import { base32Decode, base32Encode, HmacTotpGenerator } from './hmac-totp-generator';

describe('chiffrement des secrets de double authentification (FieldCipher du kit)', () => {
  const key = randomBytes(32).toString('base64');
  const fromConfig = (raw: string | undefined, nodeEnv: string) =>
    FieldCipher.fromConfig(raw, nodeEnv, 'IDENTITY_MFA_ENCRYPTION_KEY');

  it('relit un secret chiffré par l’ancien chiffrement d’identity (format v1, même clé)', () => {
    // Chiffré produit par l'ancienne classe AesGcmSecretCipher avec cette clé, pour le compte « user-legacy ».
    const cipher = fromConfig('CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws=', 'production');
    const legacy = 'v1.BQUFBQUFBQUFBQUF.9SYqJdjBSeticty8qkehNw.ySbG8Ia8F9cUB0EsWT3zsw';
    expect(cipher.decrypt(legacy, 'user-legacy')).toBe('JBSWY3DPEHPK3PXP');
    expect(() => cipher.decrypt(legacy, 'user-other')).toThrow();
  });

  it('chiffre puis déchiffre (aller-retour), avec un chiffré différent à chaque fois', () => {
    const cipher = fromConfig(key, 'production');
    const first = cipher.encrypt('JBSWY3DPEHPK3PXP', 'user-1');
    const second = cipher.encrypt('JBSWY3DPEHPK3PXP', 'user-1');
    expect(first).toMatch(/^v2\.default\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain('JBSWY3DPEHPK3PXP');
    expect(cipher.decrypt(first, 'user-1')).toBe('JBSWY3DPEHPK3PXP');
    // La même clé relue depuis la configuration déchiffre aussi (redémarrage du service).
    expect(fromConfig(key, 'production').decrypt(second, 'user-1')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('refuse un chiffré recopié sur un autre compte ou lu avec une autre clé', () => {
    const encrypted = fromConfig(key, 'production').encrypt('secret', 'user-1');
    expect(() => fromConfig(key, 'production').decrypt(encrypted, 'user-2')).toThrow();
    expect(() =>
      fromConfig(randomBytes(32).toString('base64'), 'production').decrypt(encrypted, 'user-1'),
    ).toThrow();
  });

  it('clé obligatoire en production, temporaire ailleurs, 32 octets exigés', () => {
    expect(() => fromConfig(undefined, 'production')).toThrow(FieldKeyError);
    expect(fromConfig('', 'development').ephemeral).toBe(true);
    expect(fromConfig(key, 'development').ephemeral).toBe(false);
    expect(() => fromConfig(randomBytes(16).toString('base64'), 'test')).toThrow(FieldKeyError);
    expect(() => fromConfig('pas-du-base64!', 'test')).toThrow(FieldKeyError);
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
