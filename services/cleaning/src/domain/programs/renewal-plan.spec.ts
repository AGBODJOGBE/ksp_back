import { previewPlan, type SchedulePlan } from '../schedule-plan/plan';
import { renewedPlan } from './renewal-plan';

const LIMITS = { maxMonths: 12, maxSessions: 104 };

function plan(patch: Partial<SchedulePlan>): SchedulePlan {
  return {
    kind: 'weekly',
    startTime: '09:00',
    dates: [],
    weekdays: ['tue'],
    everyWeeks: null,
    monthDays: [],
    monthWeekdays: [],
    startDate: '2026-11-03',
    endDate: null,
    durationWeeks: 8,
    durationMonths: null,
    excludedDates: ['2026-11-17'],
    addedDates: ['2026-11-19'],
    excludeHolidays: null,
    ...patch,
  };
}

const days = (value: SchedulePlan, holidays: { date: string; name: string }[] = []) =>
  previewPlan(value, { limits: LIMITS, holidays }).preview?.occurrences.map((item) => item.date);

describe('plan d’un programme renouvelé (R-PG-07)', () => {
  it('hebdomadaire : même jour, même heure, même nombre de séances à partir du nouveau début', () => {
    const renewed = renewedPlan(plan({}), '2026-12-29', 8, [])!;
    expect(renewed).toMatchObject({
      kind: 'weekly',
      startTime: '09:00',
      weekdays: ['tue'],
      startDate: '2026-12-29',
      endDate: '2027-02-16',
      durationWeeks: null,
      durationMonths: null,
      excludedDates: [],
      addedDates: [],
    });
    expect(days(renewed)).toHaveLength(8);
    expect(days(renewed)?.[0]).toBe('2026-12-29');
  });

  it('un jour férié de la nouvelle période repousse la fin : le nombre de séances est tenu', () => {
    const holidays = [{ date: '2027-01-05', name: 'Jour férié' }];
    const renewed = renewedPlan(plan({}), '2026-12-29', 8, holidays)!;
    expect(renewed.endDate).toBe('2027-02-23');
    expect(days(renewed, holidays)).toHaveLength(8);
    expect(days(renewed, holidays)).not.toContain('2027-01-05');
  });

  it('début en milieu de semaine : la première séance est le premier jour du rythme', () => {
    const renewed = renewedPlan(plan({}), '2026-12-30', 2, [])!;
    expect(days(renewed)).toEqual(['2027-01-05', '2027-01-12']);
  });

  it('toutes les 12 semaines : la recherche va assez loin', () => {
    const renewed = renewedPlan(plan({ everyWeeks: 12 }), '2026-12-29', 3, [])!;
    expect(days({ ...renewed })).toEqual(['2026-12-29', '2027-03-23', '2027-06-15']);
  });

  it('mensuel : même jour du mois, durée en mois remplacée par une date de fin', () => {
    const monthly = plan({
      kind: 'monthly',
      weekdays: [],
      monthDays: [15],
      durationWeeks: null,
      durationMonths: 3,
    });
    const renewed = renewedPlan(monthly, '2027-01-01', 3, [])!;
    expect(renewed).toMatchObject({ startDate: '2027-01-01', endDate: '2027-03-15', durationMonths: null });
    expect(days(renewed)).toEqual(['2027-01-15', '2027-02-15', '2027-03-15']);
  });

  it('plan ponctuel, nombre nul ou date invalide : aucun plan', () => {
    expect(renewedPlan(plan({ kind: 'one_off' }), '2026-12-29', 2, [])).toBeNull();
    expect(renewedPlan(plan({}), '2026-12-29', 0, [])).toBeNull();
    expect(renewedPlan(plan({}), '2026-02-30', 2, [])).toBeNull();
  });
});
