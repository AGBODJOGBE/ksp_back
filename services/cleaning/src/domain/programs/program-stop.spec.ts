import { cancelProgramByKsp, stopProgramByCustomer } from './program-stop';

const at = (iso: string) => new Date(iso);
const session = (
  id: string,
  status: 'completed' | 'in_progress' | 'assigned' | 'to_assign' | 'suspended' | 'cancelled',
  start: string,
) => ({
  id,
  status,
  scheduledStart: at(start),
});
/** Programme du lundi : séance 2 en cours, séances 3 à 5 à venir. */
const SESSIONS = [
  session('s-1', 'completed', '2026-11-16T09:00:00+01:00'),
  session('s-3', 'assigned', '2026-11-23T09:00:00+01:00'),
  session('s-4', 'to_assign', '2026-11-30T09:00:00+01:00'),
  session('s-5', 'suspended', '2026-12-07T09:00:00+01:00'),
  session('s-6', 'cancelled', '2026-12-14T09:00:00+01:00'),
  session('s-2', 'in_progress', '2026-11-20T09:00:00+01:00'),
];

describe('arrêt d’un programme par le client (partie 12)', () => {
  const stop = (now: string, status: 'in_progress' | 'suspended' | 'completed' = 'in_progress') =>
    stopProgramByCustomer({ status }, SESSIONS, { now: at(now), freeCancellationHours: 24 });

  it('plus de 24 h avant la plus proche : toutes les séances à venir sont annulées', () => {
    expect(stop('2026-11-22T09:00:00+01:00')).toEqual({
      status: 'cancelled',
      cancelledSessionIds: ['s-3', 's-4', 's-5'],
      maintainedSessionId: null,
    });
  });

  it('la plus proche à moins de 24 h est maintenue (et reste due) ; les autres sont annulées', () => {
    expect(stop('2026-11-22T09:00:01+01:00')).toEqual({
      status: 'cancelled',
      cancelledSessionIds: ['s-4', 's-5'],
      maintainedSessionId: 's-3',
    });
  });

  it('un programme suspendu s’arrête aussi ; terminé : CLEANING_INVALID_TRANSITION', () => {
    expect(stop('2026-11-22T09:00:00+01:00', 'suspended').status).toBe('cancelled');
    expect(() => stop('2026-11-22T09:00:00+01:00', 'completed')).toThrow(
      expect.objectContaining({ code: 'CLEANING_INVALID_TRANSITION' }),
    );
  });

  it('cas limite : une séance suspendue proche n’est jamais maintenue', () => {
    const frozen = [session('s-5', 'suspended', '2026-11-23T09:00:00+01:00')];
    expect(
      stopProgramByCustomer({ status: 'suspended' }, frozen, {
        now: at('2026-11-23T08:00:00+01:00'),
        freeCancellationHours: 24,
      }),
    ).toEqual({
      status: 'cancelled',
      cancelledSessionIds: ['s-5'],
      maintainedSessionId: null,
    });
  });
});

describe('arrêt d’un programme par KSP (partie 12)', () => {
  const cancel = (reason: string, requestedBy: string, approvedBy: string) =>
    cancelProgramByKsp({ status: 'in_progress' }, SESSIONS, { reason, requestedBy, approvedBy });

  it('motif et validation par un autre admin : toutes les séances à venir sont annulées, rien à payer', () => {
    expect(cancel('Fermeture du site', 'sup-1', 'admin-1')).toEqual({
      status: 'cancelled',
      cancelledSessionIds: ['s-3', 's-4', 's-5'],
    });
  });

  it('même personne : CLEANING_SECOND_APPROVER_REQUIRED ; motif vide : CLEANING_REASON_REQUIRED', () => {
    expect(() => cancel('Fermeture', 'sup-1', 'sup-1')).toThrow(
      expect.objectContaining({ code: 'CLEANING_SECOND_APPROVER_REQUIRED' }),
    );
    expect(() => cancel('', 'sup-1', 'admin-1')).toThrow(
      expect.objectContaining({ code: 'CLEANING_REASON_REQUIRED' }),
    );
  });
});
