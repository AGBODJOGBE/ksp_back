import { ExecutionRuleError } from './errors';
import {
  assertSessionTransition,
  canTransitionSession,
  isClosedSession,
  SESSION_STATUSES,
  type SessionStatus,
} from './session-status';

/** Transitions de la partie 15.2, recopiées telles quelles : [de, vers, réservée au back-office]. */
const TABLE: ReadonlyArray<[SessionStatus, SessionStatus, boolean]> = [
  ['to_assign', 'assigned', false],
  ['assigned', 'to_assign', false],
  ['assigned', 'in_progress', false],
  ['in_progress', 'interrupted', false],
  ['interrupted', 'in_progress', false],
  ['in_progress', 'completed', false],
  ['assigned', 'missed', false],
  ['to_assign', 'suspended', false],
  ['assigned', 'suspended', false],
  ['to_assign', 'cancelled', false],
  ['assigned', 'cancelled', false],
  ['suspended', 'cancelled', false],
  ['interrupted', 'cancelled', false],
  ['suspended', 'to_assign', false],
  ['interrupted', 'to_assign', false],
  ['assigned', 'completed', true],
  ['interrupted', 'completed', true],
  ['in_progress', 'missed', true],
];

describe('transitions d’une séance (15.2)', () => {
  it.each(TABLE)('%s → %s est permise (back-office seul : %s)', (from, to, staffOnly) => {
    expect(canTransitionSession(from, to, 'staff')).toBe(true);
    expect(canTransitionSession(from, to, 'team')).toBe(!staffOnly);
  });

  it('toute autre transition est refusée, quel que soit l’auteur', () => {
    const allowed = new Set(TABLE.map(([from, to]) => `${from}>${to}`));
    for (const from of SESSION_STATUSES) {
      for (const to of SESSION_STATUSES) {
        if (allowed.has(`${from}>${to}`)) continue;
        expect(canTransitionSession(from, to, 'staff')).toBe(false);
      }
    }
  });

  it('cas limites : une séance close ne bouge plus, une séance suspendue ne démarre pas', () => {
    expect(canTransitionSession('completed', 'in_progress', 'staff')).toBe(false);
    expect(canTransitionSession('missed', 'completed', 'staff')).toBe(false);
    expect(canTransitionSession('cancelled', 'to_assign', 'staff')).toBe(false);
    expect(canTransitionSession('suspended', 'in_progress', 'staff')).toBe(false);
    expect(canTransitionSession('to_assign', 'in_progress', 'staff')).toBe(false);
  });

  it('un refus porte CLEANING_INVALID_TRANSITION avec details.from et details.to', () => {
    expect(() => assertSessionTransition('assigned', 'in_progress', 'team')).not.toThrow();
    let error: unknown;
    try {
      assertSessionTransition('interrupted', 'completed', 'team');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ExecutionRuleError);
    expect(error).toMatchObject({
      code: 'CLEANING_INVALID_TRANSITION',
      details: { from: 'interrupted', to: 'completed' },
    });
  });

  it('séances closes : réalisée, manquée, annulée', () => {
    expect(SESSION_STATUSES.filter(isClosedSession)).toEqual(['completed', 'missed', 'cancelled']);
  });
});
