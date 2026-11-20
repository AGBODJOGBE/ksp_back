import {
  addBusinessDays,
  addDays,
  addDaysToInstant,
  addMonths,
  dayOfWeek,
  daysBetween,
  isBusinessDay,
  isLocalDay,
  localDay,
  localInstant,
} from './calendar';

const NO_HOLIDAYS = new Set<string>();

describe('jours du Bénin', () => {
  it('reconnaît un jour valide et refuse un jour impossible', () => {
    expect(isLocalDay('2026-02-28')).toBe(true);
    expect(isLocalDay('2026-02-30')).toBe(false);
    expect(isLocalDay('28/02/2026')).toBe(false);
  });

  it('donne le jour local à UTC+1 : 23 h 30 UTC est déjà le lendemain à Cotonou', () => {
    expect(localDay(new Date('2026-11-20T23:30:00Z'))).toBe('2026-11-21');
    expect(localDay(new Date('2026-11-20T22:59:00Z'))).toBe('2026-11-20');
  });

  it('convertit une heure locale en instant', () => {
    expect(localInstant('2026-11-20', 8).toISOString()).toBe('2026-11-20T07:00:00.000Z');
    expect(localInstant('2026-11-20', 23, 59).toISOString()).toBe('2026-11-20T22:59:00.000Z');
    expect(() => localInstant('2026-13-01', 8)).toThrow(RangeError);
  });

  it('ajoute des jours et des mois, ramenés au dernier jour du mois', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-11-15', 14)).toBe('2028-01-15');
    expect(daysBetween('2026-11-20', '2026-12-01')).toBe(11);
    expect(daysBetween('2026-12-01', '2026-11-20')).toBe(-11);
    expect(addDaysToInstant(new Date('2026-11-20T10:00:00Z'), 2).toISOString()).toBe(
      '2026-11-22T10:00:00.000Z',
    );
  });

  it('compte les jours ouvrés du lundi au vendredi, hors jours fériés', () => {
    expect(dayOfWeek('2026-11-20')).toBe(5); // vendredi
    expect(isBusinessDay('2026-11-21', NO_HOLIDAYS)).toBe(false);
    expect(addBusinessDays('2026-11-20', 1, NO_HOLIDAYS)).toBe('2026-11-23');
    expect(addBusinessDays('2026-11-20', 2, new Set(['2026-11-23']))).toBe('2026-11-25');
    expect(addBusinessDays('2026-11-20', 0, NO_HOLIDAYS)).toBe('2026-11-20');
  });
});
