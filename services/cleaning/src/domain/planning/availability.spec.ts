import { type AgendaEntry } from './agenda';
import {
  checkAvailabilityChange,
  checkUnavailabilityDeclaration,
  fitsAvailability,
  loadExcesses,
  overlappingUnavailabilities,
  type WeeklyRange,
} from './availability';

const at = (iso: string) => new Date(iso);
const p = (start: string, end: string) => ({ start: at(start), end: at(end) });
const NOW = at('2026-11-16T08:00:00+01:00');
const h = (hours: number) => hours * 60;

/** Lundi 7 h – 13 h et 15 h – 18 h ; mardi 7 h – 13 h et 13 h – 18 h ; dimanche 22 h – 24 h ; lundi 0 h – 2 h. */
const WEEKLY: WeeklyRange[] = [
  { weekday: 1, startMinute: h(7), endMinute: h(13) },
  { weekday: 1, startMinute: h(15), endMinute: h(18) },
  { weekday: 2, startMinute: h(7), endMinute: h(13) },
  { weekday: 2, startMinute: h(13), endMinute: h(18) },
  { weekday: 7, startMinute: h(22), endMinute: h(24) },
  { weekday: 1, startMinute: 0, endMinute: h(2) },
];

function entry(id: string, start: string, end: string, extra: Partial<AgendaEntry> = {}): AgendaEntry {
  return {
    assignmentId: id,
    target: { kind: 'session', id: `session-${id}` },
    placeId: 'place-a',
    start: at(start),
    end: at(end),
    travelMinutes: 0,
    status: 'confirmed',
    respondBefore: null,
    ...extra,
  };
}

describe('disponibilité hebdomadaire et exceptionnelle (R-DS-01, R-DS-02)', () => {
  it('la séance tient exactement dans une plage (bornes incluses au début, exclues à la fin)', () => {
    expect(fitsAvailability(p('2026-11-16T07:00:00+01:00', '2026-11-16T13:00:00+01:00'), WEEKLY, [])).toBe(
      true,
    );
  });

  it('une minute avant la plage ou après sa fin : hors plage', () => {
    expect(fitsAvailability(p('2026-11-16T06:59:00+01:00', '2026-11-16T09:00:00+01:00'), WEEKLY, [])).toBe(
      false,
    );
    expect(fitsAvailability(p('2026-11-16T12:00:00+01:00', '2026-11-16T13:01:00+01:00'), WEEKLY, [])).toBe(
      false,
    );
  });

  it('plages contiguës : la séance peut les enjamber ; un trou entre deux plages la refuse', () => {
    expect(fitsAvailability(p('2026-11-17T12:00:00+01:00', '2026-11-17T14:00:00+01:00'), WEEKLY, [])).toBe(
      true,
    );
    expect(fitsAvailability(p('2026-11-16T12:00:00+01:00', '2026-11-16T16:00:00+01:00'), WEEKLY, [])).toBe(
      false,
    );
  });

  it('les plages se lisent à l’heure de Porto-Novo, y compris à cheval sur minuit', () => {
    expect(fitsAvailability(p('2026-11-15T23:00:00+01:00', '2026-11-16T01:00:00+01:00'), WEEKLY, [])).toBe(
      true,
    );
    // 06:00 UTC = 07:00 à Porto-Novo : dans la plage du lundi.
    expect(fitsAvailability(p('2026-11-16T06:00:00Z', '2026-11-16T08:00:00Z'), WEEKLY, [])).toBe(true);
    // 07:00 UTC = 08:00 à Porto-Novo : fin à 13 h 00 locale + 1 h, hors plage.
    expect(fitsAvailability(p('2026-11-16T07:00:00Z', '2026-11-16T12:01:00Z'), WEEKLY, [])).toBe(false);
  });

  it('une disponibilité exceptionnelle complète ou remplace le modèle', () => {
    const extra = [{ id: 'x1', ...p('2026-11-18T08:00:00+01:00', '2026-11-18T12:00:00+01:00') }];
    expect(fitsAvailability(p('2026-11-18T08:00:00+01:00', '2026-11-18T12:00:00+01:00'), WEEKLY, extra)).toBe(
      true,
    );
    expect(fitsAvailability(p('2026-11-18T08:00:00+01:00', '2026-11-18T12:00:01+01:00'), WEEKLY, extra)).toBe(
      false,
    );
    const bridge = [{ id: 'x2', ...p('2026-11-16T13:00:00+01:00', '2026-11-16T15:00:00+01:00') }];
    expect(
      fitsAvailability(p('2026-11-16T12:00:00+01:00', '2026-11-16T16:00:00+01:00'), WEEKLY, bridge),
    ).toBe(true);
  });

  it('sans aucune plage : jamais disponible', () => {
    expect(fitsAvailability(p('2026-11-16T08:00:00+01:00', '2026-11-16T09:00:00+01:00'), [], [])).toBe(false);
  });
});

describe('indisponibilité déclarée (R-DS-02)', () => {
  const leave = {
    id: 'u1',
    reason: 'leave' as const,
    ...p('2026-11-18T00:00:00+01:00', '2026-11-19T00:00:00+01:00'),
  };

  it('toute indisponibilité qui chevauche la période est rendue, dans l’ordre', () => {
    const sick = {
      id: 'u2',
      reason: 'sickness' as const,
      ...p('2026-11-18T23:00:00+01:00', '2026-11-19T10:00:00+01:00'),
    };
    expect(
      overlappingUnavailabilities(p('2026-11-18T22:00:00+01:00', '2026-11-19T02:00:00+01:00'), [sick, leave]),
    ).toEqual([leave, sick]);
  });

  it('fin du congé = début de la période : aucune', () => {
    expect(
      overlappingUnavailabilities(p('2026-11-19T00:00:00+01:00', '2026-11-19T02:00:00+01:00'), [leave]),
    ).toEqual([]);
  });
});

describe('déclarer une indisponibilité qui chevauche des affectations (R-DS-04)', () => {
  const agenda = [
    entry('a1', '2026-11-18T09:00:00+01:00', '2026-11-18T11:00:00+01:00', { travelMinutes: 30 }),
    entry('a2', '2026-11-19T09:00:00+01:00', '2026-11-19T11:00:00+01:00'),
    entry('a3', '2026-11-18T12:00:00+01:00', '2026-11-18T13:00:00+01:00', { status: 'removed' }),
  ];

  it('refusée avec la liste des affectations touchées, trajet compris', () => {
    expect(
      checkUnavailabilityDeclaration(
        p('2026-11-18T00:00:00+01:00', '2026-11-18T08:31:00+01:00'),
        agenda,
        false,
        NOW,
      ),
    ).toEqual({
      ok: false,
      errors: [{ code: 'CLEANING_UNAVAILABILITY_CONFLICT', details: { assignments: ['a1'] } }],
    });
  });

  it('fin = début du trajet : acceptée', () => {
    expect(
      checkUnavailabilityDeclaration(
        p('2026-11-18T00:00:00+01:00', '2026-11-18T08:30:00+01:00'),
        agenda,
        false,
        NOW,
      ),
    ).toEqual({ ok: true, value: { toUnassign: [] } });
  });

  it('forcée par le superviseur : acceptée, les affectations touchées sont à désaffecter', () => {
    expect(
      checkUnavailabilityDeclaration(
        p('2026-11-18T00:00:00+01:00', '2026-11-20T00:00:00+01:00'),
        agenda,
        true,
        NOW,
      ),
    ).toEqual({ ok: true, value: { toUnassign: ['a1', 'a2'] } });
  });
});

describe('retirer une plage occupée (R-DS-05)', () => {
  const monday = entry('a1', '2026-11-23T08:00:00+01:00', '2026-11-23T10:00:00+01:00');
  const past = entry('a0', '2026-11-09T08:00:00+01:00', '2026-11-09T10:00:00+01:00');
  const forced = entry('a2', '2026-11-25T20:00:00+01:00', '2026-11-25T21:00:00+01:00');
  const agenda = [monday, past, forced];

  it('une plage qui garde les affectations à venir : acceptée', () => {
    const next: WeeklyRange[] = [{ weekday: 1, startMinute: h(8), endMinute: h(10) }];
    expect(
      checkAvailabilityChange({ current: WEEKLY, next, extras: [], agenda, bySupervisor: false, now: NOW }),
    ).toEqual({
      ok: true,
      value: { toUnassign: [] },
    });
  });

  it('l’agent retire une plage occupée : refusé avec les affectations ; une affectation déjà hors plage ne compte pas', () => {
    const next: WeeklyRange[] = [{ weekday: 1, startMinute: h(8), endMinute: h(9) + 59 }];
    expect(
      checkAvailabilityChange({ current: WEEKLY, next, extras: [], agenda, bySupervisor: false, now: NOW }),
    ).toEqual({
      ok: false,
      errors: [{ code: 'CLEANING_AVAILABILITY_IN_USE', details: { assignments: ['a1'] } }],
    });
  });

  it('le superviseur peut le faire : affectations touchées rendues pour être retirées', () => {
    expect(
      checkAvailabilityChange({
        current: WEEKLY,
        next: [],
        extras: [],
        agenda,
        bySupervisor: true,
        now: NOW,
      }),
    ).toEqual({
      ok: true,
      value: { toUnassign: ['a1'] },
    });
  });
});

describe('charge maximale (R-DS-03)', () => {
  const agenda = [
    entry('a1', '2026-11-18T06:00:00+01:00', '2026-11-18T12:00:00+01:00', { travelMinutes: 30 }),
    entry('a2', '2026-11-16T08:00:00+01:00', '2026-11-16T18:00:00+01:00'),
    entry('a3', '2026-11-17T08:00:00+01:00', '2026-11-17T18:00:00+01:00'),
    entry('a4', '2026-11-19T08:00:00+01:00', '2026-11-19T18:00:00+01:00'),
    entry('r', '2026-11-18T13:00:00+01:00', '2026-11-18T20:00:00+01:00', { status: 'removed' }),
  ];

  it('jour : 6 h + 2 h = 8 h, au maximum : accepté ; le trajet ne compte pas', () => {
    expect(
      loadExcesses(
        p('2026-11-18T14:00:00+01:00', '2026-11-18T16:00:00+01:00'),
        agenda,
        { maxHoursPerDay: 8, maxHoursPerWeek: 48 },
        NOW,
      ),
    ).toEqual([]);
  });

  it('jour : une minute de trop est signalée', () => {
    expect(
      loadExcesses(
        p('2026-11-18T14:00:00+01:00', '2026-11-18T16:01:00+01:00'),
        agenda,
        { maxHoursPerDay: 8, maxHoursPerWeek: 48 },
        NOW,
      ),
    ).toEqual([{ scope: 'day', from: '2026-11-18', plannedMinutes: 481, maximumMinutes: 480 }]);
  });

  it('semaine du lundi au dimanche, heure de Porto-Novo : 36 h + 13 h = 49 h > 48 h', () => {
    expect(
      loadExcesses(
        p('2026-11-22T08:00:00+01:00', '2026-11-22T21:00:00+01:00'),
        agenda,
        { maxHoursPerDay: 24, maxHoursPerWeek: 48 },
        NOW,
      ),
    ).toEqual([{ scope: 'week', from: '2026-11-16', plannedMinutes: 49 * 60, maximumMinutes: 48 * 60 }]);
  });

  it('séance à cheval sur minuit : chaque jour compte sa part ; la semaine suivante est à part', () => {
    expect(
      loadExcesses(
        p('2026-11-22T20:00:00+01:00', '2026-11-23T03:00:00+01:00'),
        agenda,
        { maxHoursPerDay: 3, maxHoursPerWeek: 48 },
        NOW,
      ),
    ).toEqual([{ scope: 'day', from: '2026-11-22', plannedMinutes: 240, maximumMinutes: 180 }]);
  });
});
