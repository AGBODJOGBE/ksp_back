import {
  type AgendaEntry,
  occupiedPeriod,
  scheduleConflicts,
  travelFromMatrix,
  travelMinutes,
} from './agenda';

const at = (iso: string) => new Date(iso);
const NOW = at('2026-11-20T08:00:00+01:00');
const DEFAULT_TRAVEL = 30;

/** Trajets en voiture entre lieux (minutes), dans les deux sens. */
const travel = travelFromMatrix({
  'place-a': { 'place-b': 30, 'place-c': 20 },
  'place-b': { 'place-a': 30, 'place-c': 45 },
  'place-c': { 'place-a': 20, 'place-b': 45 },
});

function entry(
  id: string,
  placeId: string,
  start: string,
  end: string,
  extra: Partial<AgendaEntry> = {},
): AgendaEntry {
  return {
    assignmentId: id,
    target: { kind: 'session', id: `session-${id}` },
    placeId,
    start: at(start),
    end: at(end),
    travelMinutes: 0,
    status: 'confirmed',
    respondBefore: null,
    ...extra,
  };
}

function candidate(placeId: string, start: string, end: string) {
  return { target: { kind: 'session' as const, id: 'session-new' }, placeId, start: at(start), end: at(end) };
}

describe('temps de trajet (R-ZN-02)', () => {
  it('pas d’affectation précédente : 0', () => {
    expect(travelMinutes(null, 'place-a', travel, DEFAULT_TRAVEL)).toBe(0);
  });

  it('même lieu : 0, sans calcul', () => {
    const lookup = jest.fn(() => 99);
    expect(travelMinutes('place-a', 'place-a', lookup, DEFAULT_TRAVEL)).toBe(0);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('lieux différents : temps calculé ; calcul indisponible : valeur par défaut des réglages', () => {
    expect(travelMinutes('place-a', 'place-b', travel, DEFAULT_TRAVEL)).toBe(30);
    expect(travelMinutes('place-a', 'place-z', travel, DEFAULT_TRAVEL)).toBe(30);
    expect(travelMinutes('place-a', 'place-z', () => null, 45)).toBe(45);
    expect(travelMinutes('place-a', 'place-c', travel, DEFAULT_TRAVEL)).toBe(20);
  });

  it('période occupée : début moins le trajet, jusqu’à la fin', () => {
    expect(
      occupiedPeriod(
        entry('a1', 'place-a', '2026-11-20T10:00:00+01:00', '2026-11-20T12:00:00+01:00', {
          travelMinutes: 30,
        }),
      ),
    ).toEqual({
      start: at('2026-11-20T09:30:00+01:00'),
      end: at('2026-11-20T12:00:00+01:00'),
    });
  });
});

describe('chevauchement avec l’agenda de l’agent (9.4, trajet compris)', () => {
  const morningAtA = entry('a1', 'place-a', '2026-11-20T08:00:00+01:00', '2026-11-20T10:00:00+01:00');

  it('fin = début de la suivante au même lieu : aucun conflit, trajet 0', () => {
    const result = scheduleConflicts(
      candidate('place-a', '2026-11-20T10:00:00+01:00', '2026-11-20T12:00:00+01:00'),
      [morningAtA],
      travel,
      DEFAULT_TRAVEL,
      NOW,
    );
    expect(result).toEqual({
      travelMinutes: 0,
      occupied: { start: at('2026-11-20T10:00:00+01:00'), end: at('2026-11-20T12:00:00+01:00') },
      conflicts: [],
    });
  });

  it('trajet juste suffisant depuis l’affectation précédente : accepté', () => {
    const result = scheduleConflicts(
      candidate('place-b', '2026-11-20T10:30:00+01:00', '2026-11-20T12:00:00+01:00'),
      [morningAtA],
      travel,
      DEFAULT_TRAVEL,
      NOW,
    );
    expect(result.conflicts).toEqual([]);
    expect(result.travelMinutes).toBe(30);
    expect(result.occupied.start).toEqual(at('2026-11-20T10:00:00+01:00'));
  });

  it('trajet insuffisant d’une minute : conflit, trajet compté', () => {
    const result = scheduleConflicts(
      candidate('place-b', '2026-11-20T10:29:00+01:00', '2026-11-20T12:00:00+01:00'),
      [morningAtA],
      travel,
      DEFAULT_TRAVEL,
      NOW,
    );
    expect(result.conflicts).toEqual([
      {
        assignmentId: 'a1',
        target: { kind: 'session', id: 'session-a1' },
        start: at('2026-11-20T08:00:00+01:00'),
        end: at('2026-11-20T10:00:00+01:00'),
        travelMinutes: 30,
      },
    ]);
  });

  it('calcul indisponible : la valeur par défaut fixe la borne', () => {
    const noOsrm = () => null;
    const ok = scheduleConflicts(
      candidate('place-b', '2026-11-20T10:30:00+01:00', '2026-11-20T11:00:00+01:00'),
      [morningAtA],
      noOsrm,
      30,
      NOW,
    );
    const ko = scheduleConflicts(
      candidate('place-b', '2026-11-20T10:29:59+01:00', '2026-11-20T11:00:00+01:00'),
      [morningAtA],
      noOsrm,
      30,
      NOW,
    );
    expect(ok.conflicts).toHaveLength(0);
    expect(ko.conflicts).toHaveLength(1);
  });

  it('affectation suivante : il faut aussi le temps de rejoindre son lieu', () => {
    const next = entry('a2', 'place-c', '2026-11-20T12:20:00+01:00', '2026-11-20T14:00:00+01:00');
    const fits = scheduleConflicts(
      candidate('place-a', '2026-11-20T10:00:00+01:00', '2026-11-20T12:00:00+01:00'),
      [next],
      travel,
      DEFAULT_TRAVEL,
      NOW,
    );
    expect(fits.conflicts).toEqual([]);
    const tooLate = scheduleConflicts(
      candidate('place-a', '2026-11-20T10:00:00+01:00', '2026-11-20T12:00:01+01:00'),
      [next],
      travel,
      DEFAULT_TRAVEL,
      NOW,
    );
    expect(tooLate.conflicts).toEqual([expect.objectContaining({ assignmentId: 'a2', travelMinutes: 20 })]);
  });

  it('affectation suivante : son trajet déjà enregistré compte aussi (même réponse que la base)', () => {
    const next = entry('a2', 'place-a', '2026-11-20T12:30:00+01:00', '2026-11-20T14:00:00+01:00', {
      travelMinutes: 45,
    });
    const result = scheduleConflicts(
      candidate('place-a', '2026-11-20T10:00:00+01:00', '2026-11-20T12:00:00+01:00'),
      [next],
      travel,
      DEFAULT_TRAVEL,
      NOW,
    );
    expect(result.conflicts).toEqual([expect.objectContaining({ assignmentId: 'a2', travelMinutes: 45 })]);
    const atBound = scheduleConflicts(
      candidate('place-a', '2026-11-20T10:00:00+01:00', '2026-11-20T11:45:00+01:00'),
      [next],
      travel,
      DEFAULT_TRAVEL,
      NOW,
    );
    expect(atBound.conflicts).toEqual([]);
  });

  it('recouvrement direct : conflit, sans trajet compté', () => {
    const result = scheduleConflicts(
      candidate('place-b', '2026-11-20T09:00:00+01:00', '2026-11-20T11:00:00+01:00'),
      [morningAtA],
      travel,
      DEFAULT_TRAVEL,
      NOW,
    );
    expect(result.conflicts).toEqual([expect.objectContaining({ assignmentId: 'a1', travelMinutes: 0 })]);
  });

  it('trajet compté depuis la plus tardive des précédentes ; les plus anciennes ne comptent pas', () => {
    const early = entry('a0', 'place-b', '2026-11-20T06:00:00+01:00', '2026-11-20T07:00:00+01:00');
    const result = scheduleConflicts(
      candidate('place-c', '2026-11-20T10:20:00+01:00', '2026-11-20T11:00:00+01:00'),
      [early, morningAtA],
      travel,
      DEFAULT_TRAVEL,
      NOW,
    );
    expect(result).toEqual(expect.objectContaining({ travelMinutes: 20, conflicts: [] }));
  });

  it('deux précédentes finissant au même instant : le trajet le plus long compte', () => {
    const atB = entry('a3', 'place-b', '2026-11-20T09:00:00+01:00', '2026-11-20T10:00:00+01:00');
    const result = scheduleConflicts(
      candidate('place-c', '2026-11-20T10:30:00+01:00', '2026-11-20T11:00:00+01:00'),
      [morningAtA, atB],
      travel,
      DEFAULT_TRAVEL,
      NOW,
    );
    expect(result.travelMinutes).toBe(45);
    expect(result.conflicts.map((conflict) => conflict.assignmentId)).toEqual(['a1', 'a3']);
  });

  it('ignorées : affectation retirée, refusée, attente échue, et la cible elle-même', () => {
    const entries = [
      entry('r', 'place-a', '2026-11-20T10:00:00+01:00', '2026-11-20T12:00:00+01:00', { status: 'removed' }),
      entry('d', 'place-a', '2026-11-20T10:00:00+01:00', '2026-11-20T12:00:00+01:00', { status: 'declined' }),
      entry('e', 'place-a', '2026-11-20T10:00:00+01:00', '2026-11-20T12:00:00+01:00', {
        status: 'pending_confirmation',
        respondBefore: at('2026-11-20T07:00:00+01:00'),
      }),
      entry('same', 'place-a', '2026-11-20T10:00:00+01:00', '2026-11-20T12:00:00+01:00', {
        target: { kind: 'session', id: 'session-new' },
      }),
    ];
    const result = scheduleConflicts(
      candidate('place-b', '2026-11-20T10:00:00+01:00', '2026-11-20T12:00:00+01:00'),
      entries,
      travel,
      DEFAULT_TRAVEL,
      NOW,
    );
    expect(result).toEqual(expect.objectContaining({ travelMinutes: 0, conflicts: [] }));
  });

  it('une proposition et une attente en cours occupent l’agenda', () => {
    const entries = [
      entry('p', 'place-a', '2026-11-20T10:00:00+01:00', '2026-11-20T11:00:00+01:00', { status: 'proposed' }),
      entry('w', 'place-a', '2026-11-20T11:00:00+01:00', '2026-11-20T12:00:00+01:00', {
        status: 'pending_confirmation',
        respondBefore: at('2026-11-20T20:00:00+01:00'),
      }),
    ];
    const result = scheduleConflicts(
      candidate('place-a', '2026-11-20T10:30:00+01:00', '2026-11-20T11:30:00+01:00'),
      entries,
      travel,
      DEFAULT_TRAVEL,
      NOW,
    );
    expect(result.conflicts.map((conflict) => conflict.assignmentId)).toEqual(['p', 'w']);
  });

  it('une visite d’une autre cible de même identifiant mais d’un autre type n’est pas la cible', () => {
    const visit = entry('v', 'place-a', '2026-11-20T10:00:00+01:00', '2026-11-20T11:00:00+01:00', {
      target: { kind: 'visit', id: 'session-new' },
    });
    const result = scheduleConflicts(
      candidate('place-a', '2026-11-20T10:00:00+01:00', '2026-11-20T11:00:00+01:00'),
      [visit],
      travel,
      DEFAULT_TRAVEL,
      NOW,
    );
    expect(result.conflicts).toHaveLength(1);
  });
});
