import { addSuspensionCause, liftSuspensionCause, overdueSuspensionDecision } from './suspension';

const at = (iso: string) => new Date(iso);
const NOW = at('2026-11-24T11:00:00+01:00');
const running = { status: 'in_progress' as const, causes: [], suspendedAt: null };
const sessions = [
  { id: 's-1', status: 'completed' as const, agentIds: ['agent-1'] },
  { id: 's-2', status: 'in_progress' as const, agentIds: ['agent-2'] },
  { id: 's-3', status: 'assigned' as const, agentIds: ['agent-1', 'agent-3'] },
  { id: 's-4', status: 'to_assign' as const, agentIds: [] },
  { id: 's-5', status: 'cancelled' as const, agentIds: [] },
];

describe('suspension pour retard d’un particulier (R-PP-04, R-SU-01, R-SU-02)', () => {
  it('1 séance en retard, seuil 1 : suspendre ; 0 : rien', () => {
    const decide = (overdueCount: number, causes: ReadonlyArray<{ cause: 'overdue_sessions' }> = []) =>
      overdueSuspensionDecision({ status: 'in_progress', causes, overdueCount, threshold: 1 });
    expect(decide(1)).toBe('add');
    expect(decide(0)).toBe('none');
    expect(decide(1, [{ cause: 'overdue_sessions' }])).toBe('none');
    expect(decide(0, [{ cause: 'overdue_sessions' }])).toBe('lift');
  });

  it('seuil 2 : une séance en retard ne suspend pas ; repasser sous le seuil lève la cause', () => {
    const decide = (overdueCount: number, active: boolean) =>
      overdueSuspensionDecision({
        status: 'suspended',
        causes: active ? [{ cause: 'overdue_sessions' }] : [],
        overdueCount,
        threshold: 2,
      });
    expect(decide(1, false)).toBe('none');
    expect(decide(2, false)).toBe('add');
    expect(decide(1, true)).toBe('lift');
  });

  it('programme terminé ou annulé : rien à suspendre', () => {
    expect(
      overdueSuspensionDecision({ status: 'completed', causes: [], overdueCount: 3, threshold: 1 }),
    ).toBe('none');
  });

  it('suspension : séances à venir gelées, agents libérés, la séance en cours continue', () => {
    const result = addSuspensionCause(running, sessions, { cause: 'overdue_sessions', now: NOW });
    expect(result.effect).toBe('suspended');
    expect(result.program).toEqual({
      status: 'suspended',
      causes: [{ cause: 'overdue_sessions', since: NOW, reason: null, decidedBy: null }],
      suspendedAt: NOW,
    });
    expect(result.suspendedSessionIds).toEqual(['s-3', 's-4']);
    expect(result.releasedAgentIds).toEqual(['agent-1', 'agent-3']);
  });
});

describe('causes cumulables (R-SU-01)', () => {
  const suspended = addSuspensionCause(running, sessions, { cause: 'overdue_sessions', now: NOW }).program;

  it('décision de KSP : motif et auteur obligatoires', () => {
    expect(() =>
      addSuspensionCause(running, sessions, {
        cause: 'ksp_decision',
        now: NOW,
        reason: ' ',
        decidedBy: 'sup-1',
      }),
    ).toThrow(expect.objectContaining({ code: 'CLEANING_REASON_REQUIRED' }));
    expect(() =>
      addSuspensionCause(running, sessions, { cause: 'ksp_decision', now: NOW, reason: 'Litige' }),
    ).toThrow(expect.objectContaining({ details: { field: 'decidedBy', reason: 'required' } }));
  });

  it('seconde cause sur un programme suspendu : ajoutée, sans nouvelle suspension', () => {
    const later = at('2026-11-25T09:00:00+01:00');
    const result = addSuspensionCause(suspended, sessions, {
      cause: 'ksp_decision',
      now: later,
      reason: 'Litige',
      decidedBy: 'sup-1',
    });
    expect(result.effect).toBe('cause_added');
    expect(result.program.suspendedAt).toEqual(NOW);
    expect(result.program.causes.map((cause) => cause.cause)).toEqual(['overdue_sessions', 'ksp_decision']);
    expect(result.suspendedSessionIds).toEqual([]);
  });

  it('même cause déjà active : sans effet ; programme terminé : CLEANING_INVALID_TRANSITION', () => {
    expect(addSuspensionCause(suspended, sessions, { cause: 'overdue_sessions', now: NOW }).effect).toBe(
      'none',
    );
    expect(() =>
      addSuspensionCause({ ...running, status: 'completed' }, sessions, {
        cause: 'overdue_sessions',
        now: NOW,
      }),
    ).toThrow(expect.objectContaining({ code: 'CLEANING_INVALID_TRANSITION' }));
  });

  it('le paiement du retard reprend le programme si c’était la dernière cause', () => {
    const result = liftSuspensionCause(suspended, sessions, { cause: 'overdue_sessions' });
    expect(result.effect).toBe('resumed');
    expect(result.program).toEqual({ status: 'in_progress', causes: [], suspendedAt: null });
  });

  it('cas limite : une autre cause reste, le programme reste suspendu', () => {
    const both = addSuspensionCause(suspended, sessions, {
      cause: 'ksp_decision',
      now: NOW,
      reason: 'Litige',
      decidedBy: 'sup-1',
    }).program;
    const result = liftSuspensionCause(both, sessions, { cause: 'overdue_sessions' });
    expect(result.effect).toBe('cause_lifted');
    expect(result.program.status).toBe('suspended');
    expect(result.program.causes.map((cause) => cause.cause)).toEqual(['ksp_decision']);
  });

  it('relais : la cause qui prend le relais s’ajoute avant la levée, sans reprise intermédiaire', () => {
    const relayed = addSuspensionCause(suspended, sessions, {
      cause: 'ksp_decision',
      now: NOW,
      reason: 'Litige',
      decidedBy: 'sup-1',
    });
    const lifted = liftSuspensionCause(relayed.program, sessions, { cause: 'overdue_sessions' });
    expect([relayed.effect, lifted.effect]).toEqual(['cause_added', 'cause_lifted']);
  });

  it('cause absente : sans effet ; reprise sans séance démarrée : confirmé', () => {
    expect(liftSuspensionCause(suspended, sessions, { cause: 'unpaid_invoices' }).effect).toBe('none');
    const fresh = addSuspensionCause({ status: 'confirmed', causes: [], suspendedAt: null }, [], {
      cause: 'overdue_sessions',
      now: NOW,
    });
    expect(liftSuspensionCause(fresh.program, [], { cause: 'overdue_sessions' }).program.status).toBe(
      'confirmed',
    );
  });
});
