import {
  formatRecoveryCode,
  normalizeRecoveryCode,
  RECOVERY_CODE_ALPHABET,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_LENGTH,
} from './recovery-code';

describe('codes de récupération', () => {
  it('10 codes de 10 caractères base32 de Crockford (50 bits), sans lettre ambiguë', () => {
    expect(RECOVERY_CODE_COUNT).toBe(10);
    expect(RECOVERY_CODE_LENGTH).toBe(10);
    expect(RECOVERY_CODE_ALPHABET).toHaveLength(32);
    expect(RECOVERY_CODE_ALPHABET).not.toMatch(/[ILOU]/);
  });

  it('se présentent en deux groupes de cinq', () => {
    expect(formatRecoveryCode('7KQ2MX9PDA')).toBe('7KQ2M-X9PDA');
  });

  it.each([
    ['7KQ2M-X9PDA', '7KQ2MX9PDA'],
    ['7kq2m x9pda', '7KQ2MX9PDA'],
    [' 7KQ2MX9PDA ', '7KQ2MX9PDA'],
    ['oKQ2M-X9PDi', '0KQ2MX9PD1'],
    ['LKQ2M-X9PDA', '1KQ2MX9PDA'],
  ])('normalise la saisie %p', (input, expected) => {
    expect(normalizeRecoveryCode(input)).toBe(expected);
  });

  it.each(['', '7KQ2M', '7KQ2M-X9PDA-1', '7KQ2M-X9PDU', '7KQ2M_X9PDA', '123456'])(
    'refuse une saisie qui ne peut pas être un code (%p)',
    (input) => {
      expect(normalizeRecoveryCode(input)).toBeNull();
    },
  );
});
