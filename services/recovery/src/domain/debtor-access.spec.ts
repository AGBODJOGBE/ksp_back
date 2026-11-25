import { codeExpiry, codeResendWait, isCodeValid, isOpenToDebtor } from './debtor-access';
import { FIXED_RULES } from './settings';

const at = (iso: string) => new Date(iso);

describe('code d’accès du débiteur (ADR-061)', () => {
  const now = at('2026-11-20T10:00:00Z');

  it('valable 10 minutes', () => {
    const expiresAt = codeExpiry(now, FIXED_RULES.debtorCodeMinutes);
    expect(expiresAt.toISOString()).toBe('2026-11-20T10:10:00.000Z');
    expect(isCodeValid({ expiresAt }, at('2026-11-20T10:09:59Z'))).toBe(true);
    expect(isCodeValid({ expiresAt }, expiresAt)).toBe(false);
    expect(isCodeValid(null, now)).toBe(false);
  });

  it('un code par minute : attente arrondie à la seconde supérieure', () => {
    const resend = FIXED_RULES.debtorCodeResendSeconds;
    expect(codeResendWait(null, now, resend)).toBe(0);
    expect(codeResendWait(now, now, resend)).toBe(60);
    expect(codeResendWait(now, at('2026-11-20T10:00:59.500Z'), resend)).toBe(1);
    expect(codeResendWait(now, at('2026-11-20T10:01:00Z'), resend)).toBe(0);
  });

  it('accès ouvert seulement pour un dossier actif ou suspendu', () => {
    expect(isOpenToDebtor('active')).toBe(true);
    expect(isOpenToDebtor('suspended')).toBe(true);
    for (const status of ['draft', 'under_review', 'closed', 'rejected'] as const) {
      expect(isOpenToDebtor(status)).toBe(false);
    }
  });
});
