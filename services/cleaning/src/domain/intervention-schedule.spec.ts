import {
  DEFAULT_SCHEDULE_POLICY,
  expandSchedule,
  type InterventionSchedule,
  legacyRecurrenceOf,
  passageStart,
  scheduleFromLegacy,
  scheduleProblem,
} from './intervention-schedule';

const TZ = 'Africa/Porto-Novo';

const plan = (patch: Partial<InterventionSchedule>): InterventionSchedule => ({
  mode: 'weekly',
  dates: [],
  startDate: null,
  endDate: null,
  weekdays: [],
  everyWeeks: 1,
  monthDays: [],
  weeksOfMonth: [],
  startTime: '08:00',
  excludedDates: [],
  extraDates: [],
  ...patch,
});

const weekly = (patch: Partial<InterventionSchedule> = {}) =>
  plan({
    mode: 'weekly',
    startDate: '2026-11-10',
    endDate: '2027-11-11',
    weekdays: ['mon', 'wed', 'sat'],
    ...patch,
  });

const weekdayOf = (day: string) =>
  ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(`${day}T00:00:00Z`).getUTCDay()];

describe('plan de passages : génération exacte des dates', () => {
  it('hebdomadaire lundi, mercredi et samedi du 2026-11-10 au 2027-11-11', () => {
    const { dates, warnings } = expandSchedule(weekly());
    // 2026-11-10 est un mardi : premier passage le mercredi 11.
    expect(dates.slice(0, 4)).toEqual(['2026-11-11', '2026-11-14', '2026-11-16', '2026-11-18']);
    // 2027-11-11 est un jeudi : dernier passage le mercredi 10.
    expect(dates.at(-1)).toBe('2027-11-10');
    expect(dates).toHaveLength(157);
    expect(new Set(dates.map(weekdayOf))).toEqual(new Set(['mon', 'wed', 'sat']));
    expect(warnings).toEqual([]);
  });

  it('une semaine sur deux, comptée depuis la semaine de la date de début', () => {
    const { dates } = expandSchedule(
      weekly({ startDate: '2026-11-16', endDate: '2026-12-31', weekdays: ['mon'], everyWeeks: 2 }),
    );
    expect(dates).toEqual(['2026-11-16', '2026-11-30', '2026-12-14', '2026-12-28']);
  });

  it('une semaine sur deux quand le début tombe en milieu de semaine', () => {
    // Mercredi 18 : la semaine du lundi 16 est la première ; le lundi 16 précède le début.
    const { dates } = expandSchedule(
      weekly({ startDate: '2026-11-18', endDate: '2026-12-10', weekdays: ['mon', 'fri'], everyWeeks: 2 }),
    );
    expect(dates).toEqual(['2026-11-20', '2026-11-30', '2026-12-04']);
  });

  it('mensuel par jours du mois : un jour absent devient le dernier jour du mois, sans doublon', () => {
    const { dates, warnings } = expandSchedule(
      plan({
        mode: 'monthly',
        startDate: '2027-01-01',
        endDate: '2027-04-30',
        monthDays: [5, 30, 31],
      }),
    );
    expect(dates).toEqual([
      '2027-01-05',
      '2027-01-30',
      '2027-01-31',
      '2027-02-05',
      '2027-02-28',
      '2027-03-05',
      '2027-03-30',
      '2027-03-31',
      '2027-04-05',
      '2027-04-30',
    ]);
    expect(warnings).toEqual([
      expect.objectContaining({ code: 'moved_to_month_end', date: '2027-02-28' }),
      expect.objectContaining({ code: 'moved_to_month_end', date: '2027-04-30' }),
    ]);
  });

  it('mensuel 29 février : année bissextile ou non', () => {
    const dates = (year: number) =>
      expandSchedule(
        plan({ mode: 'monthly', startDate: `${year}-02-01`, endDate: `${year}-02-28`, monthDays: [29] }),
      ).dates;
    expect(dates(2027)).toEqual(['2027-02-28']);
    expect(
      expandSchedule(
        plan({ mode: 'monthly', startDate: '2028-02-01', endDate: '2028-02-29', monthDays: [29] }),
      ).dates,
    ).toEqual(['2028-02-29']);
  });

  it('mensuel 1er et 3e lundi, et dernier vendredi', () => {
    const first = expandSchedule(
      plan({
        mode: 'monthly',
        startDate: '2026-11-10',
        endDate: '2027-01-31',
        weekdays: ['mon'],
        weeksOfMonth: [1, 3],
      }),
    );
    // Le 1er lundi de novembre 2026 (le 2) précède le début.
    expect(first.dates).toEqual(['2026-11-16', '2026-12-07', '2026-12-21', '2027-01-04', '2027-01-18']);
    const last = expandSchedule(
      plan({
        mode: 'monthly',
        startDate: '2026-11-10',
        endDate: '2027-01-31',
        weekdays: ['fri'],
        weeksOfMonth: ['last'],
      }),
    );
    expect(last.dates).toEqual(['2026-11-27', '2026-12-25', '2027-01-29']);
  });

  it('4e et dernier lundi confondus un mois de quatre lundis : une seule date', () => {
    const { dates } = expandSchedule(
      plan({
        mode: 'monthly',
        startDate: '2027-02-01',
        endDate: '2027-02-28',
        weekdays: ['mon'],
        weeksOfMonth: [4, 'last'],
      }),
    );
    expect(dates).toEqual(['2027-02-22']);
  });

  it('dates libres : triées, sans doublon', () => {
    const { dates } = expandSchedule(
      plan({ mode: 'dates', dates: ['2026-12-24', '2026-11-20', '2026-12-24'] }),
    );
    expect(dates).toEqual(['2026-11-20', '2026-12-24']);
  });

  it('dates exclues retirées, dates ajoutées insérées, avec avertissements', () => {
    const { dates, warnings } = expandSchedule(
      weekly({
        startDate: '2026-12-21',
        endDate: '2027-01-03',
        weekdays: ['mon', 'fri'],
        excludedDates: ['2026-12-25', '2027-01-01', '2026-12-26'],
        extraDates: ['2026-12-31', '2026-12-28'],
      }),
    );
    expect(dates).toEqual(['2026-12-21', '2026-12-28', '2026-12-31']);
    expect(warnings).toEqual([
      expect.objectContaining({ code: 'excluded', date: '2026-12-25' }),
      expect.objectContaining({ code: 'excluded', date: '2027-01-01' }),
      expect.objectContaining({ code: 'excluded_not_planned', date: '2026-12-26' }),
      expect.objectContaining({ code: 'extra_already_planned', date: '2026-12-28' }),
    ]);
  });

  it('une date à la fois exclue et ajoutée reste exclue', () => {
    const { dates } = expandSchedule(
      plan({
        mode: 'dates',
        dates: ['2026-12-01'],
        excludedDates: ['2026-12-02'],
        extraDates: ['2026-12-02'],
      }),
    );
    expect(dates).toEqual(['2026-12-01']);
  });
});

describe('plan de passages : contrôles', () => {
  const limits = DEFAULT_SCHEDULE_POLICY;
  const problem = (value: InterventionSchedule) => scheduleProblem(value, limits);

  it('plans valides', () => {
    expect(problem(weekly())).toBeNull();
    expect(problem(plan({ mode: 'dates', dates: ['2026-12-01'] }))).toBeNull();
    expect(
      problem(plan({ mode: 'monthly', startDate: '2026-12-01', endDate: '2027-11-30', monthDays: [1] })),
    ).toBeNull();
  });

  it.each<[string, Partial<InterventionSchedule>, string]>([
    ['mode inconnu', { mode: 'daily' as never }, 'schedule.mode'],
    ['heure mal formée', { startTime: '8h' }, 'schedule.startTime'],
    ['heure hors bornes', { startTime: '24:00' }, 'schedule.startTime'],
    ['date impossible', { startDate: '2027-02-30' }, 'schedule.startDate'],
    ['fin avant le début', { endDate: '2026-11-01' }, 'schedule.endDate'],
    ['période trop longue', { endDate: '2029-11-10' }, 'schedule.endDate'],
    ['sans jour de semaine', { weekdays: [] }, 'schedule.weekdays'],
    ['jour inconnu', { weekdays: ['lun' as never] }, 'schedule.weekdays'],
    ['jour en double', { weekdays: ['mon', 'mon'] }, 'schedule.weekdays'],
    ['rythme hors bornes', { everyWeeks: 13 }, 'schedule.everyWeeks'],
    ['champ d’un autre mode', { monthDays: [5] }, 'schedule.monthDays'],
    ['dates libres en hebdomadaire', { dates: ['2026-12-01'] }, 'schedule.dates'],
    ['date exclue mal formée', { excludedDates: ['01/12/2026'] }, 'schedule.excludedDates'],
  ])('%s', (_label, patch, field) => {
    expect(problem(weekly(patch))).toEqual(expect.objectContaining({ field }));
  });

  it('dates libres : au moins une, pas de période ni de jours', () => {
    expect(problem(plan({ mode: 'dates' }))).toEqual(expect.objectContaining({ field: 'schedule.dates' }));
    expect(problem(plan({ mode: 'dates', dates: ['2026-12-01'], startDate: '2026-12-01' }))).toEqual(
      expect.objectContaining({ field: 'schedule.startDate' }),
    );
    expect(problem(plan({ mode: 'dates', dates: ['2026-12-01', '2029-12-02'] }))).toEqual(
      expect.objectContaining({ field: 'schedule.dates' }),
    );
  });

  it('mensuel : jours du mois ou jours de semaine avec rangs, une seule des deux formes', () => {
    const monthly = (patch: Partial<InterventionSchedule>) =>
      problem(plan({ mode: 'monthly', startDate: '2026-12-01', endDate: '2027-06-30', ...patch }));
    expect(monthly({})).toEqual(expect.objectContaining({ field: 'schedule.monthDays' }));
    expect(monthly({ monthDays: [5], weekdays: ['mon'], weeksOfMonth: [1] })).toEqual(
      expect.objectContaining({ field: 'schedule.monthDays' }),
    );
    expect(monthly({ weekdays: ['mon'] })).toEqual(
      expect.objectContaining({ field: 'schedule.weeksOfMonth' }),
    );
    expect(monthly({ weeksOfMonth: [1] })).toEqual(expect.objectContaining({ field: 'schedule.weekdays' }));
    expect(monthly({ monthDays: [32] })).toEqual(expect.objectContaining({ field: 'schedule.monthDays' }));
    expect(monthly({ weekdays: ['mon'], weeksOfMonth: [5 as never] })).toEqual(
      expect.objectContaining({ field: 'schedule.weeksOfMonth' }),
    );
    expect(monthly({ monthDays: [5], everyWeeks: 2 })).toEqual(
      expect.objectContaining({ field: 'schedule.everyWeeks' }),
    );
    expect(monthly({ weekdays: ['mon'], weeksOfMonth: [1, 'last'] })).toBeNull();
  });

  it('durée maximale réglable : la période couvre au plus N mois', () => {
    const short = { maxMonths: 12, maxVisits: 400 };
    expect(scheduleProblem(weekly({ endDate: '2027-11-09' }), short)).toBeNull();
    expect(scheduleProblem(weekly({ endDate: '2027-11-10' }), short)).toEqual(
      expect.objectContaining({ field: 'schedule.endDate' }),
    );
  });
});

describe('heure de début d’un passage, dans le fuseau du Bénin', () => {
  it('08:00 à Porto-Novo = 07:00 UTC, toute l’année (pas d’heure d’été)', () => {
    expect(passageStart('2026-11-11', '08:00', TZ).toISOString()).toBe('2026-11-11T07:00:00.000Z');
    expect(passageStart('2027-07-01', '08:00', TZ).toISOString()).toBe('2027-07-01T07:00:00.000Z');
    expect(passageStart('2027-01-01', '00:30', TZ).toISOString()).toBe('2026-12-31T23:30:00.000Z');
  });

  it('autre fuseau réglé, avec heure d’été', () => {
    expect(passageStart('2027-07-01', '08:00', 'Europe/Paris').toISOString()).toBe(
      '2027-07-01T06:00:00.000Z',
    );
    expect(passageStart('2027-01-15', '08:00', 'Europe/Paris').toISOString()).toBe(
      '2027-01-15T07:00:00.000Z',
    );
  });
});

describe('ancien format : récurrence approximative', () => {
  it('récurrence déduite du plan, pour les anciens lecteurs (billing, impayés)', () => {
    const dates = expandSchedule(weekly()).dates;
    expect(legacyRecurrenceOf(weekly(), dates)).toEqual({
      period: 'week',
      visitsPerPeriod: 3,
      durationMonths: 12,
    });
    const monthly = plan({
      mode: 'monthly',
      startDate: '2026-12-01',
      endDate: '2027-11-30',
      weekdays: ['mon', 'thu'],
      weeksOfMonth: [1, 3],
    });
    expect(legacyRecurrenceOf(monthly, expandSchedule(monthly).dates)).toEqual({
      period: 'month',
      visitsPerPeriod: 4,
      durationMonths: 12,
    });
    const free = plan({ mode: 'dates', dates: ['2026-12-01', '2026-12-15', '2027-01-10'] });
    expect(legacyRecurrenceOf(free, expandSchedule(free).dates)).toEqual({
      period: 'month',
      visitsPerPeriod: 2,
      durationMonths: 2,
    });
  });

  it('un seul passage : prestation ponctuelle, sans récurrence', () => {
    const once = plan({ mode: 'dates', dates: ['2026-12-01'] });
    expect(legacyRecurrenceOf(once, ['2026-12-01'])).toBeNull();
  });

  it('traduction de l’ancien format quand elle est exacte (un passage par période)', () => {
    const start = new Date('2026-11-16T08:30:00Z'); // lundi 16, 09:30 à Porto-Novo
    expect(scheduleFromLegacy({ period: 'week', visitsPerPeriod: 1, durationMonths: 3 }, start, TZ)).toEqual(
      plan({
        mode: 'weekly',
        startDate: '2026-11-16',
        endDate: '2027-02-15',
        weekdays: ['mon'],
        startTime: '09:30',
      }),
    );
    expect(scheduleFromLegacy({ period: 'month', visitsPerPeriod: 1, durationMonths: 2 }, start, TZ)).toEqual(
      plan({
        mode: 'monthly',
        startDate: '2026-11-16',
        endDate: '2027-01-15',
        monthDays: [16],
        startTime: '09:30',
      }),
    );
    expect(
      scheduleFromLegacy({ period: 'week', visitsPerPeriod: 2, durationMonths: 3 }, start, TZ),
    ).toBeNull();
  });
});
