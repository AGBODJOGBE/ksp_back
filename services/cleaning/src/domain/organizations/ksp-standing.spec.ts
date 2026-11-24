import { supersedesKspDecision } from './ksp-standing';

const at = (iso: string) => new Date(iso);

describe('Décision de KSP sur une organisation (RV-85)', () => {
  const suspended = { suspended: true, changedAt: at('2026-03-10T08:00:00.000Z') };
  const reactivated = { suspended: false, changedAt: at('2026-03-10T08:00:00.000Z') };

  it('applique la première décision reçue', () => {
    expect(supersedesKspDecision(null, suspended)).toBe(true);
    expect(supersedesKspDecision(null, reactivated)).toBe(true);
  });

  it('applique une décision plus récente', () => {
    expect(
      supersedesKspDecision(suspended, { suspended: false, changedAt: at('2026-03-11T08:00:00.000Z') }),
    ).toBe(true);
  });

  it('ignore une décision plus ancienne que la dernière appliquée', () => {
    expect(
      supersedesKspDecision(reactivated, { suspended: true, changedAt: at('2026-03-09T08:00:00.000Z') }),
    ).toBe(false);
  });

  it('à date égale, la suspension l’emporte', () => {
    expect(supersedesKspDecision(reactivated, suspended)).toBe(true);
    expect(supersedesKspDecision(suspended, reactivated)).toBe(false);
  });

  it('à date égale, la même décision ne change rien', () => {
    expect(supersedesKspDecision(suspended, suspended)).toBe(false);
    expect(supersedesKspDecision(reactivated, reactivated)).toBe(false);
  });
});
