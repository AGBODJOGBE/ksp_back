import { ExecutionRuleError } from '../sessions/errors';
import {
  amendableSessions,
  type AmendmentSession,
  applyAmendment,
  assertAmendable,
  requestedAmendment,
} from './amendment';

const at = (iso: string) => new Date(iso);
const HOUR = 3_600_000;

function session(
  rank: number,
  status: AmendmentSession['status'],
  paymentStatus = 'not_due',
): AmendmentSession {
  const start = at(`2026-12-${String(rank).padStart(2, '0')}T08:00:00Z`);
  return {
    id: `s-${rank}`,
    rank,
    status,
    paymentStatus,
    scheduledStart: start,
    scheduledEnd: new Date(start.getTime() + 2 * HOUR),
  };
}

const sessions = [
  session(1, 'completed', 'paid'),
  session(2, 'in_progress'),
  session(3, 'assigned'),
  session(4, 'to_assign'),
  session(5, 'to_assign', 'paid'),
  session(6, 'cancelled'),
];
const running = { status: 'in_progress' as const, causes: [], teamSize: 1, durationMinutes: 120 };

function refusal(work: () => unknown): ExecutionRuleError {
  try {
    work();
  } catch (error) {
    if (error instanceof ExecutionRuleError) return error;
    throw error;
  }
  throw new Error('Aucun refus.');
}

describe('avenant d’un programme (R-PG-06, R-EX-03)', () => {
  it('programme confirmé ou en cours seulement ; suspendu : code propre', () => {
    expect(() => assertAmendable({ status: 'confirmed', causes: [] })).not.toThrow();
    const suspended = refusal(() => assertAmendable({ status: 'suspended', causes: ['overdue_sessions'] }));
    expect(suspended.code).toBe('CLEANING_PROGRAM_SUSPENDED');
    expect(suspended.details).toEqual({ causes: ['overdue_sessions'] });
    for (const status of ['completed', 'cancelled'] as const) {
      expect(refusal(() => assertAmendable({ status, causes: [] })).code).toBe('CLEANING_INVALID_TRANSITION');
    }
  });

  it('séances que l’avenant peut changer : ni démarrées, ni closes, ni payées', () => {
    expect(amendableSessions(sessions).map((item) => item.id)).toEqual(['s-3', 's-4']);
  });

  it('demande : au moins un type ou une séance, sans doublon', () => {
    const base = { currentTypeIds: ['sol'], sessions };
    expect(
      requestedAmendment({ ...base, addTypeIds: ['vitres', 'vitres'], addedStarts: [] }).addedTypeIds,
    ).toEqual(['vitres']);
    const later = [at('2026-12-21T08:00:00Z'), at('2026-12-14T08:00:00Z')];
    expect(requestedAmendment({ ...base, addTypeIds: [], addedStarts: later }).addedStarts).toEqual([
      later[1],
      later[0],
    ]);
    expect(refusal(() => requestedAmendment({ ...base, addTypeIds: [], addedStarts: [] })).details).toEqual({
      field: 'addCleaningTypeIds',
      reason: 'required',
    });
    expect(
      refusal(() => requestedAmendment({ ...base, addTypeIds: ['sol'], addedStarts: [] })).details,
    ).toEqual({
      field: 'addCleaningTypeIds',
      reason: 'duplicate',
    });
    const taken = [sessions[3]!.scheduledStart];
    expect(
      refusal(() => requestedAmendment({ ...base, addTypeIds: [], addedStarts: taken })).details,
    ).toEqual({
      field: 'addSchedule',
      reason: 'duplicate',
    });
    // La date d'une séance annulée est libre.
    const freed = [sessions[5]!.scheduledStart];
    expect(requestedAmendment({ ...base, addTypeIds: [], addedStarts: freed }).addedStarts).toEqual(freed);
  });

  it('avenant accepté : nouveau prix sur les séances non démarrées, séances ajoutées à la suite', () => {
    const added = [at('2026-12-21T08:00:00Z'), at('2026-12-14T08:00:00Z')];
    const applied = applyAmendment(running, sessions, {
      sessionPrice: 12_500,
      teamSize: 1,
      durationMinutes: 120,
      addedStarts: added,
    });
    expect(applied.updated).toEqual([
      { sessionId: 's-3', price: 12_500, scheduledEnd: at('2026-12-03T10:00:00Z'), release: false },
      { sessionId: 's-4', price: 12_500, scheduledEnd: at('2026-12-04T10:00:00Z'), release: false },
    ]);
    expect(applied.added).toEqual([
      { rank: 7, scheduledStart: added[1], scheduledEnd: at('2026-12-14T10:00:00Z'), price: 12_500 },
      { rank: 8, scheduledStart: added[0], scheduledEnd: at('2026-12-21T10:00:00Z'), price: 12_500 },
    ]);
    expect(applied.sessionsCount).toBe(4);
  });

  it('équipe ou durée changée : les séances planifiées repassent « à affecter »', () => {
    const longer = applyAmendment(running, sessions, {
      sessionPrice: 12_500,
      teamSize: 1,
      durationMinutes: 180,
      addedStarts: [],
    });
    expect(longer.updated).toEqual([
      { sessionId: 's-3', price: 12_500, scheduledEnd: at('2026-12-03T11:00:00Z'), release: true },
      { sessionId: 's-4', price: 12_500, scheduledEnd: at('2026-12-04T11:00:00Z'), release: false },
    ]);
    const bigger = applyAmendment(running, sessions, {
      sessionPrice: 12_500,
      teamSize: 2,
      durationMinutes: 120,
      addedStarts: [],
    });
    expect(bigger.updated.map((item) => item.release)).toEqual([true, false]);
  });

  it('programme suspendu ou clos entre l’envoi et l’acceptation : refusé', () => {
    const terms = { sessionPrice: 12_500, teamSize: 1, durationMinutes: 120, addedStarts: [] };
    expect(
      refusal(() =>
        applyAmendment({ ...running, status: 'suspended', causes: ['ksp_decision'] }, sessions, terms),
      ).code,
    ).toBe('CLEANING_PROGRAM_SUSPENDED');
    expect(refusal(() => applyAmendment({ ...running, status: 'cancelled' }, sessions, terms)).code).toBe(
      'CLEANING_INVALID_TRANSITION',
    );
  });

  it('prix sous les frais de visite déjà déduits d’une séance : refusé', () => {
    const deducted = sessions.map((item) =>
      item.id === 's-4' ? { ...item, visitFeeDeducted: 5_000 } : item,
    );
    const terms = { sessionPrice: 4_000, teamSize: 1, durationMinutes: 120, addedStarts: [] };
    expect(refusal(() => applyAmendment(running, deducted, terms)).details).toEqual({
      field: 'sessionPrice',
      reason: 'out_of_range',
    });
    expect(applyAmendment(running, deducted, { ...terms, sessionPrice: 5_000 }).updated).toHaveLength(2);
  });
});
