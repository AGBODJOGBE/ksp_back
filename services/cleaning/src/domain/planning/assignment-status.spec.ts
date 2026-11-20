import {
  effectiveAssignmentStatus,
  initialAssignmentStatus,
  isInForce,
  isUpcoming,
  respondToAssignment,
} from './assignment-status';

const at = (iso: string) => new Date(iso);
const NOW = at('2026-11-20T08:00:00+01:00');

describe('affectation : statut initial (R-PL-08)', () => {
  const START = at('2026-11-22T09:00:00+01:00');

  it('salarié : confirmée d’office, sans échéance', () => {
    expect(initialAssignmentStatus('employee', NOW, 12, START)).toEqual({
      status: 'confirmed',
      respondBefore: null,
    });
  });

  it('indépendant : en attente de sa réponse, échéance à maintenant + délai réglé', () => {
    expect(initialAssignmentStatus('independent', NOW, 12, START)).toEqual({
      status: 'pending_confirmation',
      respondBefore: at('2026-11-20T20:00:00+01:00'),
    });
    expect(initialAssignmentStatus('independent', NOW, 1, START).respondBefore).toEqual(
      at('2026-11-20T09:00:00+01:00'),
    );
  });

  it('indépendant : au plus tard au début de la cible (décision du 20 novembre 2026)', () => {
    const soon = at('2026-11-20T14:00:00+01:00');
    expect(initialAssignmentStatus('independent', NOW, 12, soon)).toEqual({
      status: 'pending_confirmation',
      respondBefore: soon,
    });
    const exactly = at('2026-11-20T20:00:00+01:00');
    expect(initialAssignmentStatus('independent', NOW, 12, exactly).respondBefore).toEqual(exactly);
    expect(
      initialAssignmentStatus('independent', NOW, 12, at('2026-11-20T20:00:00.001+01:00')).respondBefore,
    ).toEqual(at('2026-11-20T20:00:00+01:00'));
  });
});

describe('affectation : statut effectif d’après l’heure (15.2)', () => {
  const pending = { status: 'pending_confirmation' as const, respondBefore: at('2026-11-20T20:00:00+01:00') };

  it('en attente jusqu’à l’échéance incluse', () => {
    expect(effectiveAssignmentStatus(pending, at('2026-11-20T19:59:59+01:00'))).toBe('pending_confirmation');
    expect(effectiveAssignmentStatus(pending, at('2026-11-20T20:00:00+01:00'))).toBe('pending_confirmation');
  });

  it('sans réponse au-delà de l’échéance : expirée, même avant le passage de la tâche', () => {
    expect(effectiveAssignmentStatus(pending, at('2026-11-20T20:00:00.001+01:00'))).toBe('expired');
  });

  it('les autres statuts ne dépendent pas de l’heure', () => {
    expect(effectiveAssignmentStatus({ status: 'confirmed', respondBefore: null }, NOW)).toBe('confirmed');
    expect(effectiveAssignmentStatus({ status: 'pending_confirmation', respondBefore: null }, NOW)).toBe(
      'pending_confirmation',
    );
  });
});

describe('affectation en vigueur et à venir (R-PL-09, R-AG-03)', () => {
  const base = { respondBefore: null, end: at('2026-11-20T10:00:00+01:00') };

  it('proposée, en attente et confirmée sont en vigueur ; refusée, expirée et retirée non', () => {
    expect(isInForce({ ...base, status: 'proposed' }, NOW)).toBe(true);
    expect(isInForce({ ...base, status: 'pending_confirmation' }, NOW)).toBe(true);
    expect(isInForce({ ...base, status: 'confirmed' }, NOW)).toBe(true);
    expect(isInForce({ ...base, status: 'declined' }, NOW)).toBe(false);
    expect(isInForce({ ...base, status: 'expired' }, NOW)).toBe(false);
    expect(isInForce({ ...base, status: 'removed' }, NOW)).toBe(false);
  });

  it('une attente échue ne compte plus', () => {
    const late = { status: 'pending_confirmation' as const, respondBefore: at('2026-11-20T07:59:59+01:00') };
    expect(isInForce(late, NOW)).toBe(false);
  });

  it('à venir : en vigueur et fin après maintenant, en cours comprise ; fin = maintenant : passée', () => {
    expect(isUpcoming({ ...base, status: 'confirmed' }, NOW)).toBe(true);
    expect(isUpcoming({ ...base, status: 'confirmed', end: at('2026-11-20T08:00:01+01:00') }, NOW)).toBe(
      true,
    );
    expect(isUpcoming({ ...base, status: 'confirmed', end: NOW }, NOW)).toBe(false);
    expect(isUpcoming({ ...base, status: 'removed' }, NOW)).toBe(false);
  });
});

describe('réponse de l’indépendant (R-PL-08)', () => {
  const pending = { status: 'pending_confirmation' as const, respondBefore: at('2026-11-20T20:00:00+01:00') };

  it('accepte ou refuse avant l’échéance', () => {
    expect(respondToAssignment(pending, 'accept', NOW)).toEqual({ ok: true, value: 'confirmed' });
    expect(respondToAssignment(pending, 'decline', at('2026-11-20T20:00:00+01:00'))).toEqual({
      ok: true,
      value: 'declined',
    });
  });

  it('refusé après l’échéance : transition interdite depuis « expired »', () => {
    expect(respondToAssignment(pending, 'accept', at('2026-11-20T20:00:01+01:00'))).toEqual({
      ok: false,
      errors: [{ code: 'CLEANING_INVALID_TRANSITION', details: { from: 'expired', to: 'confirmed' } }],
    });
  });

  it('refusé hors attente (déjà confirmée, retirée, proposée)', () => {
    for (const status of ['confirmed', 'removed', 'proposed'] as const) {
      expect(respondToAssignment({ status, respondBefore: null }, 'decline', NOW)).toEqual({
        ok: false,
        errors: [{ code: 'CLEANING_INVALID_TRANSITION', details: { from: status, to: 'declined' } }],
      });
    }
  });
});
