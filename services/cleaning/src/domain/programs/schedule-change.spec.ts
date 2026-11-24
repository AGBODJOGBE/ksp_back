import { ExecutionRuleError } from '../sessions/errors';
import { changeSchedule, type ScheduleChangeSession } from './schedule-change';

const at = (iso: string) => new Date(iso);
const NOW = at('2026-11-24T10:00:00+01:00');
const HOUR = 3_600_000;

/** Programme hebdomadaire du mardi 9 h, 2 h par séance : 3 réalisées, 5 à venir. */
function weekly(): ScheduleChangeSession[] {
  const days = ['11-03', '11-10', '11-17', '11-24', '12-01', '12-08', '12-15', '12-22'];
  return days.map((day, index) => {
    const start = at(`2026-${day}T09:00:00+01:00`);
    return {
      id: `s-${index + 1}`,
      rank: index + 1,
      status:
        index < 3 ? ('completed' as const) : index === 4 ? ('assigned' as const) : ('to_assign' as const),
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 2 * HOUR),
    };
  });
}

/** Les mêmes semaines, le jeudi 14 h. */
const thursdays = ['11-26', '12-03', '12-10', '12-17', '12-24'].map((day) =>
  at(`2026-${day}T14:00:00+01:00`),
);
const running = { status: 'in_progress' as const, causes: [] };
const input = {
  effectiveFrom: '2026-11-24',
  newStarts: thursdays,
  durationMinutes: null,
  reason: 'À la demande du client',
  actorId: 'staff-1',
  now: NOW,
};

function refusal(work: () => unknown): ExecutionRuleError {
  try {
    work();
  } catch (error) {
    if (error instanceof ExecutionRuleError) return error;
    throw error;
  }
  throw new Error('Aucun refus.');
}

describe('changement de plan (R-PG-06, R-RP-01)', () => {
  it('déplace les séances à venir dans l’ordre des rangs ; les séances réalisées ne bougent pas', () => {
    const change = changeSchedule(running, weekly(), input);
    expect(change.moves.map((move) => move.sessionId)).toEqual(['s-4', 's-5', 's-6', 's-7', 's-8']);
    expect(change.moves.map((move) => move.scheduledStart)).toEqual(thursdays);
    expect(change.moves[1]).toEqual({
      sessionId: 's-5',
      rank: 5,
      status: 'to_assign',
      wasAssigned: true,
      scheduledStart: thursdays[1],
      scheduledEnd: new Date(thursdays[1]!.getTime() + 2 * HOUR),
      reschedule: {
        previousStart: at('2026-12-01T09:00:00+01:00'),
        previousEnd: at('2026-12-01T11:00:00+01:00'),
        newStart: thursdays[1],
        newEnd: new Date(thursdays[1]!.getTime() + 2 * HOUR),
        by: 'ksp',
        at: NOW,
        reason: 'À la demande du client',
        actorId: 'staff-1',
      },
    });
    expect(change.durationMinutes).toBeNull();
  });

  it('la date d’effet laisse en place les séances qui commencent avant', () => {
    const change = changeSchedule(running, weekly(), {
      ...input,
      effectiveFrom: '2026-12-02',
      newStarts: thursdays.slice(2),
    });
    expect(change.moves.map((move) => move.sessionId)).toEqual(['s-6', 's-7', 's-8']);
  });

  it('une durée donnée change la durée des séances déplacées, jamais leur nombre', () => {
    const change = changeSchedule(running, weekly(), { ...input, durationMinutes: 180 });
    expect(change.durationMinutes).toBe(180);
    for (const move of change.moves) {
      expect(move.scheduledEnd.getTime() - move.scheduledStart.getTime()).toBe(3 * HOUR);
    }
  });

  it('une séance dont le créneau ne change pas n’est pas touchée', () => {
    const sessions = weekly();
    const change = changeSchedule(running, sessions, {
      ...input,
      effectiveFrom: '2026-12-01',
      newStarts: [sessions[4]!.scheduledStart, ...thursdays.slice(2)],
    });
    expect(change.moves.map((move) => move.sessionId)).toEqual(['s-6', 's-7', 's-8']);
  });

  it('un nombre de séances différent passe par un avenant', () => {
    const error = refusal(() =>
      changeSchedule(running, weekly(), { ...input, newStarts: thursdays.slice(1) }),
    );
    expect(error.code).toBe('CLEANING_AMENDMENT_REQUIRED');
    expect(error.details).toEqual({ sessions: 5, planned: 4 });
  });

  it('un plan sans date est refusé', () => {
    expect(refusal(() => changeSchedule(running, weekly(), { ...input, newStarts: [] })).code).toBe(
      'CLEANING_SCHEDULE_EMPTY',
    );
  });

  it('programme suspendu, terminé ou annulé : refusé', () => {
    const suspended = refusal(() =>
      changeSchedule({ status: 'suspended', causes: ['ksp_decision'] }, weekly(), input),
    );
    expect(suspended.code).toBe('CLEANING_PROGRAM_SUSPENDED');
    expect(suspended.details).toEqual({ causes: ['ksp_decision'] });
    for (const status of ['completed', 'cancelled'] as const) {
      expect(refusal(() => changeSchedule({ status, causes: [] }, weekly(), input)).code).toBe(
        'CLEANING_INVALID_TRANSITION',
      );
    }
  });

  it('motif obligatoire, date d’effet et durée contrôlées', () => {
    expect(refusal(() => changeSchedule(running, weekly(), { ...input, reason: ' ' })).code).toBe(
      'CLEANING_REASON_REQUIRED',
    );
    expect(
      refusal(() => changeSchedule(running, weekly(), { ...input, effectiveFrom: '24/11' })).details,
    ).toEqual({ field: 'effectiveFrom', reason: 'invalid_type' });
    for (const durationMinutes of [10, 1500, 90.5]) {
      expect(refusal(() => changeSchedule(running, weekly(), { ...input, durationMinutes })).details).toEqual(
        {
          field: 'durationMinutes',
          reason: 'out_of_range',
        },
      );
    }
  });

  it('une nouvelle date passée ou antérieure à la date d’effet est refusée', () => {
    const past = [at('2026-11-24T08:00:00+01:00'), ...thursdays.slice(1)];
    expect(refusal(() => changeSchedule(running, weekly(), { ...input, newStarts: past })).details).toEqual({
      field: 'schedule',
      reason: 'out_of_range',
    });
    const early = refusal(() =>
      changeSchedule(running, weekly(), {
        ...input,
        effectiveFrom: '2026-12-02',
        newStarts: [at('2026-12-01T14:00:00+01:00'), ...thursdays.slice(3)],
      }),
    );
    expect(early.details).toEqual({ field: 'schedule', reason: 'out_of_range' });
  });

  it('une nouvelle date ne chevauche pas une séance qui reste en place', () => {
    const sessions = weekly();
    sessions[3] = { ...sessions[3]!, status: 'in_progress' };
    const clash = [at('2026-11-24T10:30:00+01:00'), ...thursdays.slice(2)];
    const error = refusal(() => changeSchedule(running, sessions, { ...input, newStarts: clash }));
    expect(error.code).toBe('CLEANING_RESCHEDULE_OVERLAP');
    expect(error.details).toEqual({ sessionId: 's-4' });
  });
});
