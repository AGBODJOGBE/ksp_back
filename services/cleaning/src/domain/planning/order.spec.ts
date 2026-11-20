import { compareIds, comparePlanningOrder } from './order';

const at = (iso: string) => new Date(iso);
const target = (kind: 'session' | 'visit', id: string, start = '2026-11-23T09:00:00+01:00') => ({
  target: { kind, id },
  start: at(start),
});

describe('compareIds : points de code', () => {
  it('cas nominal : ordre croissant, égalité', () => {
    expect(compareIds('a', 'b')).toBe(-1);
    expect(compareIds('b', 'a')).toBe(1);
    expect(compareIds('a', 'a')).toBe(0);
  });

  it('cas limite : majuscule avant minuscule, lettre accentuée après z (indépendant de la langue)', () => {
    expect(compareIds('B', 'a')).toBe(-1);
    expect(compareIds('é', 'f')).toBe(1);
  });
});

describe('comparePlanningOrder : début, type, identifiant (R-PL-11)', () => {
  it('cas nominal : la cible qui commence la première passe devant', () => {
    const early = target('visit', 'z', '2026-11-23T08:00:00+01:00');
    expect(comparePlanningOrder(early, target('session', 'a'))).toBeLessThan(0);
  });

  it('cas limite : même début, la séance avant la visite, puis l’identifiant', () => {
    expect(comparePlanningOrder(target('session', 'z'), target('visit', 'a'))).toBeLessThan(0);
    expect(comparePlanningOrder(target('session', 'b'), target('session', 'a'))).toBeGreaterThan(0);
    expect(comparePlanningOrder(target('session', 'a'), target('session', 'a'))).toBe(0);
  });
});
