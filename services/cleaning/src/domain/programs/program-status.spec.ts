import type { SessionStatus } from '../sessions/session-status';
import {
  assertProgramTransition,
  canTransitionProgram,
  isTerminalProgram,
  PROGRAM_STATUSES,
  type ProgramStatus,
  programProgress,
} from './program-status';

const TABLE: ReadonlyArray<[ProgramStatus, ProgramStatus]> = [
  ['confirmed', 'in_progress'],
  ['in_progress', 'completed'],
  ['confirmed', 'suspended'],
  ['in_progress', 'suspended'],
  ['suspended', 'confirmed'],
  ['suspended', 'in_progress'],
  ['confirmed', 'cancelled'],
  ['in_progress', 'cancelled'],
  ['suspended', 'cancelled'],
];

describe('transitions d’un programme (15.2)', () => {
  it.each(TABLE)('%s → %s est permise', (from, to) => {
    expect(canTransitionProgram(from, to)).toBe(true);
  });

  it('toute autre transition est refusée (CLEANING_INVALID_TRANSITION)', () => {
    const allowed = new Set(TABLE.map(([from, to]) => `${from}>${to}`));
    for (const from of PROGRAM_STATUSES) {
      for (const to of PROGRAM_STATUSES) {
        if (!allowed.has(`${from}>${to}`)) expect(canTransitionProgram(from, to)).toBe(false);
      }
    }
    expect(() => assertProgramTransition('completed', 'suspended')).toThrow(
      expect.objectContaining({
        code: 'CLEANING_INVALID_TRANSITION',
        details: { from: 'completed', to: 'suspended' },
      }),
    );
    expect(() => assertProgramTransition('confirmed', 'in_progress')).not.toThrow();
  });

  it('cas limites : un programme suspendu ne se termine pas sans reprise ; terminé et annulé sont finaux', () => {
    expect(canTransitionProgram('suspended', 'completed')).toBe(false);
    expect(canTransitionProgram('confirmed', 'completed')).toBe(false);
    expect(PROGRAM_STATUSES.filter(isTerminalProgram)).toEqual(['completed', 'cancelled']);
  });
});

describe('progression d’après les séances (partie 8, R-PL-10)', () => {
  const sessions = (...statuses: SessionStatus[]) => statuses.map((status) => ({ status }));

  it('confirmé : passe « en cours » dès une séance démarrée ou réalisée', () => {
    expect(programProgress('confirmed', sessions('assigned', 'to_assign'))).toEqual([]);
    expect(programProgress('confirmed', sessions('in_progress', 'assigned'))).toEqual(['in_progress']);
    expect(programProgress('confirmed', sessions('interrupted', 'assigned'))).toEqual(['in_progress']);
  });

  it('terminé quand toutes les séances sont réalisées, manquées ou annulées', () => {
    expect(programProgress('in_progress', sessions('completed', 'missed', 'cancelled'))).toEqual([
      'completed',
    ]);
    expect(programProgress('in_progress', sessions('completed', 'assigned'))).toEqual([]);
    expect(programProgress('in_progress', sessions('completed', 'to_assign'))).toEqual([]);
  });

  it('cas limite : confirmé dont toutes les séances sont closes passe par « en cours »', () => {
    expect(programProgress('confirmed', sessions('cancelled'))).toEqual(['in_progress', 'completed']);
  });

  it('suspendu, terminé, annulé ou sans séance : pas de progression', () => {
    expect(programProgress('suspended', sessions('completed'))).toEqual([]);
    expect(programProgress('completed', sessions('completed'))).toEqual([]);
    expect(programProgress('in_progress', [])).toEqual([]);
  });
});
