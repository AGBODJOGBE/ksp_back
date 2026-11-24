/**
 * Plan de séances (partie 8). Matrice règle → tests :
 *
 * | Règle    | Cas nominal                                        | Cas limite                                              |
 * |----------|----------------------------------------------------|---------------------------------------------------------|
 * | R-PG-01  | heure de Porto-Novo → début UTC                    | le 31 ramené au dernier jour de février, signalé        |
 * | R-PG-02  | jour exclu, jour ajouté, jours fériés exclus       | férié ajouté explicitement gardé ; exclusion désactivée |
 * | R-PG-03  | 24 mois et 400 séances acceptés                    | 25 mois, séances au-delà du maximum, délai de 48 h      |
 * | R-PG-04  | liste exacte des dates et leur nombre              | aucune date restante                                    |
 * | R-PG-09  | une seule forme de fin, durée de N mois            | champ d'un autre plan, toutes les N semaines depuis le  |
 * |          |                                                    | lundi, « 4e » = dernier, exclu prioritaire, signalements |
 */
import { type SchedulePlan, firstSessionRespectsLead, previewPlan } from './plan';

const plan = (patch: Partial<SchedulePlan>): SchedulePlan => ({
  kind: 'weekly',
  startTime: '08:30',
  dates: [],
  weekdays: [],
  everyWeeks: null,
  monthDays: [],
  monthWeekdays: [],
  startDate: null,
  endDate: null,
  durationWeeks: null,
  durationMonths: null,
  excludedDates: [],
  addedDates: [],
  excludeHolidays: null,
  ...patch,
});
const limits = { maxMonths: 24, maxSessions: 400 };
const preview = (patch: Partial<SchedulePlan>, options: Partial<Parameters<typeof previewPlan>[1]> = {}) =>
  previewPlan(plan(patch), { limits, holidays: [], ...options });
const datesOf = (patch: Partial<SchedulePlan>, options: Partial<Parameters<typeof previewPlan>[1]> = {}) =>
  preview(patch, options).preview?.occurrences.map((occurrence) => occurrence.date);
const problemsOf = (patch: Partial<SchedulePlan>, options: Partial<Parameters<typeof previewPlan>[1]> = {}) =>
  preview(patch, options).problems;
const problem = (field: string, reason: string) => ({ field, reason });
const mondays = { weekdays: ['mon' as const], startDate: '2027-01-04', endDate: '2027-01-31' };

describe('programme ponctuel', () => {
  it('jours de passage triés, heure de Porto-Novo convertie en UTC (R-PG-01, R-PG-04)', () => {
    const result = preview({ kind: 'one_off', dates: ['2027-03-04', '2027-03-03'] });
    expect(result.problems).toEqual([]);
    expect(result.preview).toEqual({
      occurrences: [
        { date: '2027-03-03', start: new Date('2027-03-03T07:30:00.000Z') },
        { date: '2027-03-04', start: new Date('2027-03-04T07:30:00.000Z') },
      ],
      count: 2,
      firstStart: new Date('2027-03-03T07:30:00.000Z'),
      lastStart: new Date('2027-03-04T07:30:00.000Z'),
      notices: [],
    });
  });

  it('exige au moins un jour', () => {
    expect(problemsOf({ kind: 'one_off' })).toEqual([problem('dates', 'required')]);
  });

  it('refuse les champs d’un plan récurrent (R-PG-09)', () => {
    expect(
      problemsOf({
        kind: 'one_off',
        dates: ['2027-03-03'],
        weekdays: ['mon'],
        startDate: '2027-03-01',
        durationMonths: 1,
      }),
    ).toEqual([
      problem('weekdays', 'not_applicable'),
      problem('startDate', 'not_applicable'),
      problem('durationMonths', 'not_applicable'),
    ]);
  });
});

describe('programme hebdomadaire', () => {
  it('lundi et jeudi chaque semaine pendant 3 mois : 26 séances, fin à début + 3 mois − 1 jour', () => {
    const dates = datesOf({ weekdays: ['mon', 'thu'], startDate: '2027-01-04', durationMonths: 3 });
    expect(dates).toHaveLength(26);
    expect(dates?.slice(0, 3)).toEqual(['2027-01-04', '2027-01-07', '2027-01-11']);
    expect(dates?.at(-1)).toBe('2027-04-01');
    expect(datesOf({ weekdays: ['sat'], startDate: '2027-01-04', durationMonths: 3 })?.at(-1)).toBe(
      '2027-04-03',
    );
  });

  it('toutes les 2 semaines, comptées depuis le lundi de la semaine du début (R-PG-09)', () => {
    expect(
      datesOf({ weekdays: ['mon', 'thu'], everyWeeks: 2, startDate: '2027-01-07', endDate: '2027-01-31' }),
    ).toEqual(['2027-01-07', '2027-01-18', '2027-01-21']);
  });

  it('durée en semaines : début + 7 × N − 1 jours', () => {
    expect(datesOf({ weekdays: ['mon', 'sun'], startDate: '2027-01-04', durationWeeks: 2 })).toEqual([
      '2027-01-04',
      '2027-01-10',
      '2027-01-11',
      '2027-01-17',
    ]);
  });

  it('exige les jours, la date de début et une forme de fin', () => {
    expect(problemsOf({ startDate: '2027-01-04', endDate: '2027-01-31' })).toEqual([
      problem('weekdays', 'required'),
    ]);
    expect(problemsOf({ weekdays: ['mon'], endDate: '2027-01-31' })).toEqual([
      problem('startDate', 'required'),
    ]);
    expect(problemsOf({ weekdays: ['mon'], startDate: '2027-01-04' })).toEqual([
      problem('endDate', 'required'),
    ]);
  });

  it('une seule forme de fin (R-PG-09)', () => {
    expect(problemsOf({ ...mondays, durationWeeks: 2, durationMonths: 1 })).toEqual([
      problem('durationWeeks', 'not_applicable'),
      problem('durationMonths', 'not_applicable'),
    ]);
  });

  it('refuse les champs d’un autre plan', () => {
    expect(
      problemsOf({
        ...mondays,
        dates: ['2027-01-05'],
        monthDays: [1],
        monthWeekdays: [{ rank: 'first', weekday: 'mon' }],
      }),
    ).toEqual([
      problem('dates', 'not_applicable'),
      problem('monthDays', 'not_applicable'),
      problem('monthWeekdays', 'not_applicable'),
    ]);
  });

  it('contrôle le rythme, les durées et l’ordre des dates', () => {
    expect(problemsOf({ ...mondays, everyWeeks: 13 })).toEqual([problem('everyWeeks', 'out_of_range')]);
    expect(problemsOf({ ...mondays, everyWeeks: 0 })).toEqual([problem('everyWeeks', 'out_of_range')]);
    expect(problemsOf({ ...mondays, endDate: null, durationWeeks: 261 })).toEqual([
      problem('durationWeeks', 'out_of_range'),
    ]);
    expect(problemsOf({ ...mondays, endDate: null, durationMonths: 0 })).toEqual([
      problem('durationMonths', 'out_of_range'),
    ]);
    expect(problemsOf({ ...mondays, endDate: '2027-01-03' })).toEqual([problem('endDate', 'out_of_range')]);
  });

  it('accepte la fin le jour du début', () => {
    expect(datesOf({ ...mondays, endDate: '2027-01-04' })).toEqual(['2027-01-04']);
  });
});

describe('programme mensuel', () => {
  it('le 31 de chaque mois : ramené au dernier jour de février, signalé (R-PG-01)', () => {
    const result = preview({ kind: 'monthly', monthDays: [31], startDate: '2027-01-01', durationMonths: 3 });
    expect(result.preview?.occurrences.map((occurrence) => occurrence.date)).toEqual([
      '2027-01-31',
      '2027-02-28',
      '2027-03-31',
    ]);
    expect(result.preview?.notices).toEqual([
      { code: 'month_day_adjusted', date: '2027-02-28', label: null },
    ]);
  });

  it('le 30 et le 31 en février : une seule séance après le report (R-PG-09)', () => {
    expect(
      datesOf({ kind: 'monthly', monthDays: [31, 30], startDate: '2027-02-01', endDate: '2027-02-28' }),
    ).toEqual(['2027-02-28']);
  });

  it('durée d’un mois depuis le 31 janvier : fin le 27 février', () => {
    expect(
      datesOf({ kind: 'monthly', monthDays: [27, 28], startDate: '2027-01-31', durationMonths: 1 }),
    ).toEqual(['2027-02-27']);
  });

  it('1er samedi de chaque mois', () => {
    expect(
      datesOf({
        kind: 'monthly',
        monthWeekdays: [{ rank: 'first', weekday: 'sat' }],
        startDate: '2027-01-01',
        durationMonths: 2,
      }),
    ).toEqual(['2027-01-02', '2027-02-06']);
  });

  it('« 4e » lundi = dernier lundi quand il n’y en a que quatre : dédoublonné (R-PG-09)', () => {
    expect(
      datesOf({
        kind: 'monthly',
        monthWeekdays: [
          { rank: 'fourth', weekday: 'mon' },
          { rank: 'last', weekday: 'mon' },
        ],
        startDate: '2027-02-01',
        endDate: '2027-03-31',
      }),
    ).toEqual(['2027-02-22', '2027-03-22', '2027-03-29']);
  });

  it('2e et 3e jeudi', () => {
    expect(
      datesOf({
        kind: 'monthly',
        monthWeekdays: [
          { rank: 'second', weekday: 'thu' },
          { rank: 'third', weekday: 'thu' },
        ],
        startDate: '2027-04-01',
        endDate: '2027-04-30',
      }),
    ).toEqual(['2027-04-08', '2027-04-15']);
  });

  it('jours du mois ou jours de semaine à un rang, pas les deux ni aucun', () => {
    const period = { kind: 'monthly' as const, startDate: '2027-01-01', durationMonths: 2 };
    expect(
      problemsOf({ ...period, monthDays: [1], monthWeekdays: [{ rank: 'last', weekday: 'fri' }] }),
    ).toEqual([problem('monthWeekdays', 'not_applicable')]);
    expect(problemsOf(period)).toEqual([problem('monthDays', 'required')]);
    expect(problemsOf({ ...period, monthDays: [0, 32] })).toEqual([
      problem('monthDays[0]', 'out_of_range'),
      problem('monthDays[1]', 'out_of_range'),
    ]);
    expect(problemsOf({ ...period, monthDays: [1], weekdays: ['mon'], everyWeeks: 2 })).toEqual([
      problem('weekdays', 'not_applicable'),
      problem('everyWeeks', 'not_applicable'),
    ]);
  });
});

describe('jours exclus, ajoutés et fériés (R-PG-02, R-PG-09)', () => {
  it('exclut, ajoute et signale chaque ajustement ; un jour exclu reste exclu même ajouté', () => {
    const result = preview({
      ...mondays,
      excludedDates: ['2027-01-11', '2027-01-12'],
      addedDates: ['2027-01-13', '2027-01-18', '2027-01-11'],
    });
    expect(result.preview?.occurrences.map((occurrence) => occurrence.date)).toEqual([
      '2027-01-04',
      '2027-01-13',
      '2027-01-18',
      '2027-01-25',
    ]);
    expect(result.preview?.notices).toEqual([
      { code: 'date_excluded', date: '2027-01-11', label: null },
      { code: 'excluded_not_planned', date: '2027-01-12', label: null },
      { code: 'date_added', date: '2027-01-13', label: null },
      { code: 'added_already_planned', date: '2027-01-18', label: null },
    ]);
  });

  it('exclut les jours fériés par défaut, garde un férié ajouté explicitement', () => {
    const holidays = [
      { date: '2027-01-18', name: 'Fête A' },
      { date: '2027-01-25', name: 'Fête B' },
      { date: '2027-01-20', name: 'Fête C' },
    ];
    const result = preview({ ...mondays, addedDates: ['2027-01-25'] }, { holidays });
    expect(result.preview?.occurrences.map((occurrence) => occurrence.date)).toEqual([
      '2027-01-04',
      '2027-01-11',
      '2027-01-25',
    ]);
    expect(result.preview?.notices).toEqual([
      { code: 'added_already_planned', date: '2027-01-25', label: null },
      { code: 'holiday_excluded', date: '2027-01-18', label: 'Fête A' },
    ]);
  });

  it('un férié aussi exclu par le client n’est signalé qu’une fois', () => {
    const holidays = [{ date: '2027-01-18', name: 'Fête A' }];
    expect(preview({ ...mondays, excludedDates: ['2027-01-18'] }, { holidays }).preview?.notices).toEqual([
      { code: 'date_excluded', date: '2027-01-18', label: null },
    ]);
  });

  it('garde les jours fériés si leur exclusion est désactivée', () => {
    const holidays = [{ date: '2027-01-18', name: 'Fête A' }];
    expect(datesOf({ ...mondays, excludeHolidays: false }, { holidays })).toHaveLength(4);
  });

  it('refuse une date mal formée ou inexistante, et un doublon', () => {
    expect(
      problemsOf({
        ...mondays,
        excludedDates: ['2027-02-30', '2027-1-5'],
        addedDates: ['2027-01-05', '2027-01-05'],
      }),
    ).toEqual([
      problem('excludedDates[0]', 'invalid_type'),
      problem('excludedDates[1]', 'invalid_type'),
      problem('addedDates[1]', 'duplicate'),
    ]);
  });

  it('refuse une heure de début invalide', () => {
    expect(problemsOf({ ...mondays, startTime: '24:00' })).toEqual([problem('startTime', 'invalid_type')]);
  });
});

describe('bornes du programme (R-PG-03)', () => {
  it('24 mois acceptés, 25 refusés', () => {
    expect(problemsOf({ weekdays: ['mon'], startDate: '2027-01-04', durationMonths: 24 })).toEqual([]);
    expect(problemsOf({ weekdays: ['mon'], startDate: '2027-01-04', durationMonths: 25 })).toEqual([
      problem('durationMonths', 'out_of_range'),
    ]);
    expect(problemsOf({ weekdays: ['mon'], startDate: '2027-01-04', endDate: '2029-01-04' })).toEqual([
      problem('endDate', 'out_of_range'),
    ]);
  });

  it('jours ponctuels ou ajoutés couvrant plus que la durée maximale', () => {
    expect(problemsOf({ kind: 'one_off', dates: ['2027-01-04', '2029-01-04'] })).toEqual([
      problem('schedule', 'out_of_range'),
    ]);
    expect(problemsOf({ ...mondays, addedDates: ['2029-01-04'] })).toEqual([
      problem('schedule', 'out_of_range'),
    ]);
  });

  it('nombre de séances : au plus le maximum, au moins une', () => {
    const small = { limits: { maxMonths: 24, maxSessions: 4 } };
    expect(problemsOf(mondays, small)).toEqual([]);
    expect(problemsOf({ ...mondays, addedDates: ['2027-01-05'] }, small)).toEqual([
      problem('schedule', 'out_of_range'),
    ]);
    expect(
      problemsOf({ ...mondays, excludedDates: ['2027-01-04', '2027-01-11', '2027-01-18', '2027-01-25'] }),
    ).toEqual([problem('schedule', 'required')]);
  });

  it('première séance au moins 48 h après maintenant', () => {
    const result = preview(mondays).preview!;
    expect(firstSessionRespectsLead(result, new Date('2027-01-02T07:30:00.000Z'), 48)).toBe(true);
    expect(firstSessionRespectsLead(result, new Date('2027-01-02T07:31:00.000Z'), 48)).toBe(false);
    expect(firstSessionRespectsLead({ ...result, firstStart: null }, new Date(), 48)).toBe(false);
  });

  it('aucun aperçu tant que le plan a un défaut', () => {
    expect(preview({ kind: 'one_off' }).preview).toBeNull();
  });
});
