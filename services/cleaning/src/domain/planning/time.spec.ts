import {
  addDays,
  isoWeekMonday,
  localDayStart,
  localDaysTouched,
  localPosition,
  minutesBetween,
  overlapMinutes,
  overlaps,
  PLANNING_TIME_ZONE,
} from './time';

const at = (iso: string) => new Date(iso);
const p = (start: string, end: string) => ({ start: at(start), end: at(end) });

describe('périodes semi-ouvertes [début, fin)', () => {
  it('fin = début de la suivante : pas de chevauchement', () => {
    expect(
      overlaps(
        p('2026-11-20T08:00:00Z', '2026-11-20T10:00:00Z'),
        p('2026-11-20T10:00:00Z', '2026-11-20T11:00:00Z'),
      ),
    ).toBe(false);
  });

  it('une milliseconde de recouvrement suffit', () => {
    expect(
      overlaps(
        p('2026-11-20T08:00:00Z', '2026-11-20T10:00:00.001Z'),
        p('2026-11-20T10:00:00Z', '2026-11-20T11:00:00Z'),
      ),
    ).toBe(true);
  });

  it('minutes et minutes communes', () => {
    expect(minutesBetween(at('2026-11-20T08:00:00Z'), at('2026-11-20T09:30:00Z'))).toBe(90);
    expect(
      overlapMinutes(
        p('2026-11-20T08:00:00Z', '2026-11-20T10:00:00Z'),
        p('2026-11-20T09:00:00Z', '2026-11-20T12:00:00Z'),
      ),
    ).toBe(60);
    expect(
      overlapMinutes(
        p('2026-11-20T08:00:00Z', '2026-11-20T09:00:00Z'),
        p('2026-11-20T09:00:00Z', '2026-11-20T12:00:00Z'),
      ),
    ).toBe(0);
  });
});

describe('heure locale (Africa/Porto-Novo, UTC+1 sans heure d’été)', () => {
  it('le fuseau du module est Africa/Porto-Novo', () => {
    expect(PLANNING_TIME_ZONE).toBe('Africa/Porto-Novo');
  });

  it('23 h 30 UTC est déjà le lendemain à Porto-Novo', () => {
    expect(localPosition(at('2026-11-22T23:30:00Z'))).toEqual({ day: '2026-11-23', weekday: 1, minute: 30 });
  });

  it('minuit local, dimanche = 7', () => {
    expect(localPosition(at('2026-11-21T23:00:00Z'))).toEqual({ day: '2026-11-22', weekday: 7, minute: 0 });
    expect(localDayStart('2026-11-22')).toEqual(at('2026-11-21T23:00:00Z'));
  });

  it('jours calendaires, changement de mois et d’année', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('lundi de la semaine ISO', () => {
    expect(isoWeekMonday('2026-11-23')).toBe('2026-11-23');
    expect(isoWeekMonday('2026-11-29')).toBe('2026-11-23');
    expect(isoWeekMonday('2027-01-01')).toBe('2026-12-28');
  });

  it('jours locaux touchés par une période ; une fin à minuit ne touche pas le lendemain', () => {
    expect(localDaysTouched(p('2026-11-20T21:00:00Z', '2026-11-20T23:00:00Z'))).toEqual(['2026-11-20']);
    expect(localDaysTouched(p('2026-11-20T21:00:00Z', '2026-11-20T23:00:01Z'))).toEqual([
      '2026-11-20',
      '2026-11-21',
    ]);
  });
});
