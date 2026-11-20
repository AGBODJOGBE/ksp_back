import { catchUpStart, resumeSessions } from './catch-up';

const at = (iso: string) => new Date(iso);
/** Reprise le mardi 24 novembre 2026 à 10 h (Porto-Novo), délai minimum 48 h : au-delà du 26 à 10 h. */
const NOW = at('2026-11-24T10:00:00+01:00');
const session = (
  id: string,
  rank: number,
  start: string,
  status: 'suspended' | 'assigned' | 'cancelled' = 'suspended',
) => {
  const scheduledStart = at(start);
  return {
    id,
    rank,
    status,
    scheduledStart,
    scheduledEnd: new Date(scheduledStart.getTime() + 2 * 3_600_000),
  };
};
const resume = (sessions: ReturnType<typeof session>[], excludedDays: string[] = [], maxWeeks = 8) =>
  resumeSessions({
    sessions,
    now: NOW,
    firstSessionLeadHours: 48,
    excludedDays: new Set(excludedDays),
    maxWeeks,
  });

describe('reprise des séances suspendues (R-SU-03)', () => {
  it('début après maintenant + 48 h : la séance repasse « à affecter »', () => {
    expect(resume([session('s-5', 5, '2026-11-26T10:00:01+01:00')])).toEqual({
      toAssign: ['s-5'],
      catchUp: [],
    });
  });

  it('début à maintenant + 48 h pile : trop proche, rattrapage proposé', () => {
    const result = resume([session('s-5', 5, '2026-11-26T10:00:00+01:00')]);
    expect(result.toAssign).toEqual([]);
    expect(result.catchUp).toEqual([
      {
        sessionId: 's-5',
        rank: 5,
        previousStart: at('2026-11-26T10:00:00+01:00'),
        suggestedStart: at('2026-12-03T10:00:00+01:00'),
      },
    ]);
  });

  it('séance passée : même jour de la semaine et même heure, N semaines plus tard', () => {
    const result = resume([session('s-4', 4, '2026-11-23T09:00:00+01:00')]);
    expect(result.catchUp[0]?.suggestedStart).toEqual(at('2026-11-30T09:00:00+01:00'));
  });

  it('jour exclu ou férié (Porto-Novo) : semaine suivante', () => {
    const result = resume([session('s-4', 4, '2026-11-23T09:00:00+01:00')], ['2026-11-30']);
    expect(result.catchUp[0]?.suggestedStart).toEqual(at('2026-12-07T09:00:00+01:00'));
  });

  it('sans chevaucher une autre séance du programme, ni un autre rattrapage', () => {
    const result = resume([
      session('s-3', 3, '2026-11-16T09:00:00+01:00'),
      session('s-4', 4, '2026-11-23T09:00:00+01:00'),
      session('s-6', 6, '2026-12-07T10:59:59+01:00', 'assigned'),
      session('s-7', 7, '2026-12-14T08:00:00+01:00', 'cancelled'),
    ]);
    // s-3 : le 23 est trop proche, le 30 est libre ; s-4 : le 30 est pris par s-3, le 7 chevauche s-6,
    // le 14 est libre (la séance annulée ne compte pas).
    expect(result.catchUp.map((line) => line.suggestedStart)).toEqual([
      at('2026-11-30T09:00:00+01:00'),
      at('2026-12-14T09:00:00+01:00'),
    ]);
    expect(result.toAssign).toEqual([]);
  });

  it('cas limite : fin d’une séance = début d’une autre, pas de chevauchement', () => {
    const result = resume([
      session('s-4', 4, '2026-11-23T09:00:00+01:00'),
      session('s-9', 9, '2026-11-30T11:00:00+01:00', 'assigned'),
    ]);
    expect(result.catchUp[0]?.suggestedStart).toEqual(at('2026-11-30T09:00:00+01:00'));
  });

  it('aucune date libre dans la limite : null, le superviseur décide', () => {
    const result = resume([session('s-4', 4, '2026-11-23T09:00:00+01:00')], ['2026-11-30', '2026-12-07'], 2);
    expect(result.catchUp[0]?.suggestedStart).toBeNull();
  });
});

describe('date de rattrapage seule', () => {
  it('reprend l’algorithme v1 : semaines entières après la date d’origine', () => {
    expect(
      catchUpStart({
        start: at('2026-11-23T09:00:00+01:00'),
        durationMs: 7_200_000,
        earliestExclusive: at('2026-11-26T10:00:00+01:00'),
        excludedDays: new Set(),
        busy: [],
        maxWeeks: 1,
      }),
    ).toEqual(at('2026-11-30T09:00:00+01:00'));
  });
});
