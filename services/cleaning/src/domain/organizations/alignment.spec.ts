import { alignPrograms, hasResumedProgram, type OrganizationProgram } from './alignment';

const at = (iso: string) => new Date(iso);
const resume = { firstSessionLeadHours: 48, excludedDays: () => new Set<string>(), maxWeeks: 4 };
const since = at('2027-01-01T00:00:00Z');

function program(id: string, causes: OrganizationProgram['causes'], status: OrganizationProgram['status']) {
  return { id, status, causes, suspendedAt: causes.length ? since : null, sessions: [] };
}

describe('alignement des programmes (R-SU-01)', () => {
  it('cause déjà posée ou absente : aucun changement annoncé', () => {
    const unpaid = { cause: 'unpaid_invoices' as const, since, reason: null, decidedBy: null };
    const changes = alignPrograms({
      programs: [program('p1', [unpaid], 'suspended'), program('p2', [], 'in_progress')],
      decision: { addCause: ['p1'], liftCause: ['p2'] },
      now: at('2027-02-01T00:00:00Z'),
      resume,
    });
    expect(changes).toEqual([]);
    expect(hasResumedProgram(changes)).toBe(false);
  });

  it('programme hors décision : ignoré', () => {
    expect(
      alignPrograms({
        programs: [program('p1', [], 'in_progress')],
        decision: { addCause: [], liftCause: [] },
        now: at('2027-02-01T00:00:00Z'),
        resume,
      }),
    ).toEqual([]);
  });

  it('jours exclus propres à chaque programme pour le rattrapage', () => {
    const unpaid = { cause: 'unpaid_invoices' as const, since, reason: null, decidedBy: null };
    const start = at('2027-01-20T08:00:00Z');
    const suspended = {
      ...program('p1', [unpaid], 'suspended'),
      sessions: [
        {
          id: 's1',
          rank: 1,
          status: 'suspended' as const,
          scheduledStart: start,
          scheduledEnd: at('2027-01-20T10:00:00Z'),
          agentIds: [],
        },
      ],
    };
    const [change] = alignPrograms({
      programs: [suspended],
      decision: { addCause: [], liftCause: ['p1'] },
      now: at('2027-01-25T00:00:00Z'),
      resume: { ...resume, excludedDays: (id) => new Set(id === 'p1' ? ['2027-01-27'] : []) },
    });
    expect(change).toMatchObject({
      effect: 'resumed',
      program: { status: 'confirmed' },
      resumption: {
        toAssign: [],
        catchUp: [{ sessionId: 's1', suggestedStart: at('2027-02-03T08:00:00Z') }],
      },
    });
  });
});
