import { CryptoOtpCodeGenerator } from './crypto-otp-code-generator';
import { HmacOtpHasher } from './hmac-otp-hasher';

describe('HmacOtpHasher', () => {
  const hasher = new HmacOtpHasher('s'.repeat(32));

  it('donne toujours la même empreinte pour la même demande et le même code', () => {
    expect(hasher.hash('c-1', '482913')).toBe(hasher.hash('c-1', '482913'));
  });

  it('change d’empreinte avec la demande, le code ou la clé', () => {
    const reference = hasher.hash('c-1', '482913');
    expect(hasher.hash('c-2', '482913')).not.toBe(reference);
    expect(hasher.hash('c-1', '482914')).not.toBe(reference);
    expect(new HmacOtpHasher('k'.repeat(32)).hash('c-1', '482913')).not.toBe(reference);
  });

  it('ne contient pas le code', () => {
    expect(hasher.hash('c-1', '482913')).not.toContain('482913');
  });
});

describe('CryptoOtpCodeGenerator', () => {
  const generator = new CryptoOtpCodeGenerator();

  it('produit exactement le nombre de chiffres demandé, zéros initiaux compris', () => {
    for (let i = 0; i < 500; i += 1) {
      expect(generator.generate(6)).toMatch(/^[0-9]{6}$/);
    }
    expect(generator.generate(4)).toMatch(/^[0-9]{4}$/);
  });

  it('ne répète pas le même code', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generator.generate(6)));
    expect(codes.size).toBeGreaterThan(190);
  });
});
