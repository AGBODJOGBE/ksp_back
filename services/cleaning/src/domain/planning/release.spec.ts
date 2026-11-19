import { occupiedUntilAtClose, releaseAssignments } from './release';

const at = (iso: string) => new Date(iso);
const NOW = at('2026-11-20T08:00:00+01:00');

describe('libération de l’agenda à la sortie d’une cible (R-PL-09)', () => {
  it('les affectations en vigueur sont retirées avec le motif système', () => {
    expect(
      releaseAssignments(
        [
          { assignmentId: 'p', status: 'proposed', respondBefore: null },
          {
            assignmentId: 'w',
            status: 'pending_confirmation',
            respondBefore: at('2026-11-20T20:00:00+01:00'),
          },
          { assignmentId: 'c', status: 'confirmed', respondBefore: null },
        ],
        'session_cancelled',
        NOW,
      ),
    ).toEqual([
      { assignmentId: 'p', removalReason: 'session_cancelled' },
      { assignmentId: 'w', removalReason: 'session_cancelled' },
      { assignmentId: 'c', removalReason: 'session_cancelled' },
    ]);
  });

  it('les affectations qui ne sont plus en vigueur restent telles quelles, attente échue comprise', () => {
    expect(
      releaseAssignments(
        [
          { assignmentId: 'r', status: 'removed', respondBefore: null },
          { assignmentId: 'd', status: 'declined', respondBefore: null },
          {
            assignmentId: 'e',
            status: 'pending_confirmation',
            respondBefore: at('2026-11-20T07:59:59+01:00'),
          },
        ],
        'program_cancelled',
        NOW,
      ),
    ).toEqual([]);
  });
});

describe('période occupée d’une cible réalisée ou manquée (R-PL-09)', () => {
  const occupiedFrom = at('2026-11-20T08:30:00+01:00');

  it('elle s’arrête à la fin réelle', () => {
    expect(occupiedUntilAtClose(occupiedFrom, at('2026-11-20T10:15:00+01:00'))).toEqual(
      at('2026-11-20T10:15:00+01:00'),
    );
  });

  it('fin réelle avant le début occupé + 1 min : la période garde 1 min', () => {
    expect(occupiedUntilAtClose(occupiedFrom, at('2026-11-20T08:30:30+01:00'))).toEqual(
      at('2026-11-20T08:31:00+01:00'),
    );
    expect(occupiedUntilAtClose(occupiedFrom, at('2026-11-20T08:31:00+01:00'))).toEqual(
      at('2026-11-20T08:31:00+01:00'),
    );
  });
});
