import {
  customerReschedulesInMonth,
  recheckAgents,
  rescheduleByCustomer,
  rescheduleByKsp,
} from './reschedule';
import type { SessionStatus } from './session-status';

const at = (iso: string) => new Date(iso);
const H = 3_600_000;
const slot = (id: string, start: string, status: SessionStatus = 'assigned') => ({
  id,
  status,
  scheduledStart: at(start),
  scheduledEnd: new Date(at(start).getTime() + 2 * H),
});
/** Séance du lundi 23 novembre 2026, 9 h – 11 h ; la suivante le lundi 30 à 9 h (Porto-Novo). */
const S3 = slot('s-3', '2026-11-23T09:00:00+01:00');
const PROGRAM = [
  S3,
  slot('s-4', '2026-11-30T09:00:00+01:00'),
  slot('s-9', '2026-11-26T09:00:00+01:00', 'cancelled'),
];
const NOW = at('2026-11-20T10:00:00+01:00');

describe('report par le client (partie 12, R-RP-01)', () => {
  const move = (
    newStart: string,
    extra: Partial<Parameters<typeof rescheduleByCustomer>[1]> = {},
    session = S3,
  ) =>
    rescheduleByCustomer(session, {
      programStatus: 'in_progress',
      programSessions: PROGRAM,
      newStart: at(newStart),
      actorId: 'client-1',
      now: NOW,
      freeCancellationHours: 24,
      reschedulesPerMonth: 2,
      reschedulesThisMonth: 0,
      ...extra,
    });

  it('nouvelle date libre : même séance, même statut, même durée, ancienne date dans l’historique', () => {
    const result = move('2026-11-25T14:00:00+01:00');
    expect(result).toEqual({
      status: 'assigned',
      scheduledStart: at('2026-11-25T14:00:00+01:00'),
      scheduledEnd: at('2026-11-25T16:00:00+01:00'),
      catchUpSuggestedStart: null,
      reschedule: {
        previousStart: S3.scheduledStart,
        previousEnd: S3.scheduledEnd,
        newStart: at('2026-11-25T14:00:00+01:00'),
        newEnd: at('2026-11-25T16:00:00+01:00'),
        by: 'customer',
        at: NOW,
        reason: null,
        actorId: 'client-1',
      },
    });
  });

  it('nouvelle date 24 h après maintenant pile : acceptée ; une seconde de moins : délai trop court', () => {
    expect(move('2026-11-21T10:00:00+01:00').scheduledStart).toEqual(at('2026-11-21T10:00:00+01:00'));
    expect(() => move('2026-11-21T09:59:59+01:00')).toThrow(
      expect.objectContaining({ code: 'CLEANING_LEAD_TIME_TOO_SHORT', details: { minimumHours: 24 } }),
    );
  });

  it('séance à moins de 24 h : CLEANING_CANCELLATION_TOO_LATE', () => {
    expect(() => move('2026-11-25T14:00:00+01:00', { now: at('2026-11-22T09:00:01+01:00') })).toThrow(
      expect.objectContaining({ code: 'CLEANING_CANCELLATION_TOO_LATE' }),
    );
  });

  it('chevauchement d’une autre séance non annulée : refusé ; fin = début de l’autre : accepté', () => {
    expect(() => move('2026-11-30T10:59:59+01:00')).toThrow(
      expect.objectContaining({ code: 'CLEANING_RESCHEDULE_OVERLAP', details: { sessionId: 's-4' } }),
    );
    expect(move('2026-11-30T07:00:00+01:00').scheduledEnd).toEqual(at('2026-11-30T09:00:00+01:00'));
    expect(move('2026-11-26T09:00:00+01:00').scheduledStart).toEqual(at('2026-11-26T09:00:00+01:00'));
  });

  it('2 reports ce mois-ci : le troisième est refusé', () => {
    expect(() => move('2026-11-25T14:00:00+01:00', { reschedulesThisMonth: 2 })).toThrow(
      expect.objectContaining({ code: 'CLEANING_RESCHEDULE_LIMIT_REACHED', details: { maximum: 2 } }),
    );
  });

  it('programme suspendu : CLEANING_PROGRAM_SUSPENDED ; séance en cours : refusée', () => {
    expect(() =>
      move('2026-11-25T14:00:00+01:00', { programStatus: 'suspended', programCauses: ['overdue_sessions'] }),
    ).toThrow(
      expect.objectContaining({
        code: 'CLEANING_PROGRAM_SUSPENDED',
        details: { causes: ['overdue_sessions'] },
      }),
    );
    expect(() => move('2026-11-25T14:00:00+01:00', {}, { ...S3, status: 'in_progress' })).toThrow(
      expect.objectContaining({ code: 'CLEANING_INVALID_TRANSITION' }),
    );
  });
});

describe('reports comptés dans le mois civil de Porto-Novo', () => {
  it('seuls les reports du client du mois en cours comptent', () => {
    const history = [
      { by: 'customer' as const, at: at('2026-11-01T00:00:00+01:00') },
      { by: 'customer' as const, at: at('2026-10-31T23:59:59+01:00') },
      { by: 'customer' as const, at: at('2026-10-31T23:30:00Z') },
      { by: 'ksp' as const, at: at('2026-11-10T10:00:00+01:00') },
    ];
    expect(customerReschedulesInMonth(history, NOW)).toBe(2);
  });
});

describe('report par KSP (R-RP-01, RV-70)', () => {
  const move = (
    session: ReturnType<typeof slot>,
    extra: Partial<Parameters<typeof rescheduleByKsp>[1]> = {},
  ) =>
    rescheduleByKsp(session, {
      programStatus: 'in_progress',
      programSessions: PROGRAM,
      newStart: at('2026-11-21T09:00:00+01:00'),
      reason: 'Agent malade',
      actorId: 'sup-1',
      now: NOW,
      ...extra,
    });

  it('dans le futur, même proche : accepté, motif gardé ; maintenant pile : in_past', () => {
    expect(move(S3, { newStart: new Date(NOW.getTime() + 1) }).reschedule).toMatchObject({
      by: 'ksp',
      reason: 'Agent malade',
    });
    expect(() => move(S3, { newStart: NOW })).toThrow(
      expect.objectContaining({ code: 'CLEANING_SLOT_INVALID', details: { reason: 'in_past' } }),
    );
  });

  it('durée changée de 15 min à 24 h, bornes incluses ; le prix ne bouge pas (pas de prix ici)', () => {
    expect(move(S3, { durationMinutes: 15 }).scheduledEnd).toEqual(at('2026-11-21T09:15:00+01:00'));
    expect(move(S3, { durationMinutes: 1440 }).scheduledEnd).toEqual(at('2026-11-22T09:00:00+01:00'));
    expect(() => move(S3, { durationMinutes: 14 })).toThrow(
      expect.objectContaining({ details: { field: 'durationMinutes', reason: 'out_of_range' } }),
    );
    expect(() => move(S3, { durationMinutes: 1441 })).toThrow(
      expect.objectContaining({ code: 'CLEANING_VALIDATION_FAILED' }),
    );
  });

  it('séance interrompue (après incident) ou suspendue après la reprise : repasse « à affecter »', () => {
    expect(move(slot('s-3', '2026-11-23T09:00:00+01:00', 'interrupted')).status).toBe('to_assign');
    const suspended = {
      ...slot('s-3', '2026-11-23T09:00:00+01:00', 'suspended'),
      catchUpSuggestedStart: at('2026-11-30T09:00:00+01:00'),
    };
    expect(move(suspended)).toMatchObject({ status: 'to_assign', catchUpSuggestedStart: null });
  });

  it('programme suspendu : aucun report ; motif vide : refusé ; séance réalisée : refusée', () => {
    expect(() => move(S3, { programStatus: 'suspended' })).toThrow(
      expect.objectContaining({ code: 'CLEANING_PROGRAM_SUSPENDED' }),
    );
    expect(() => move(S3, { reason: ' ' })).toThrow(
      expect.objectContaining({ code: 'CLEANING_REASON_REQUIRED' }),
    );
    expect(() => move(slot('s-3', '2026-11-23T09:00:00+01:00', 'completed'))).toThrow(
      expect.objectContaining({ code: 'CLEANING_INVALID_TRANSITION' }),
    );
  });
});

describe('agents recontrôlés au nouveau créneau (R-RP-01)', () => {
  it('ceux qui passent sont gardés ; équipe incomplète : la séance repasse « à affecter »', () => {
    const agents = [
      { agentId: 'agent-1', passes: true },
      { agentId: 'agent-2', passes: false },
    ];
    expect(recheckAgents({ status: 'assigned', teamSize: 2, agents })).toEqual({
      keptAgentIds: ['agent-1'],
      removedAgentIds: ['agent-2'],
      status: 'to_assign',
    });
  });

  it('cas limite : tous passent, l’équipe reste complète et planifiée', () => {
    const agents = [{ agentId: 'agent-1', passes: true }];
    expect(recheckAgents({ status: 'assigned', teamSize: 1, agents }).status).toBe('assigned');
    expect(recheckAgents({ status: 'to_assign', teamSize: 2, agents }).status).toBe('to_assign');
  });
});
