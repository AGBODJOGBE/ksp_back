/**
 * Visite des lieux (partie 7.3) et sa machine d'états (partie 15.2).
 *
 * Matrice règle → test :
 * - 15.2 (visite) transitions autorisées et refusées             → « transitions de 15.2 »
 * - R-VI-01 / RV-54 date au plus tôt max(demande + délai, maintenant) → « planification (R-VI-01) »
 * - R-VI-01 frais payés ou visite gratuite                        → « planification (R-VI-01) »
 * - R-VI-02 agenda occupé : durée + trajet                        → « agenda (R-VI-02) »
 * - R-VI-03 autre créneau jusqu'à 24 h avant, borne exacte        → « autre créneau (R-VI-03) »
 * - R-VI-04 / RV-60 constat pas avant l'heure, occurredAt borné   → « constat pas avant l'heure »
 * - R-VI-04 10 photos au plus                                     → « photos (R-VI-04) »
 * - R-VI-05 / RV-48 client absent : manquée, nouveaux frais       → « client absent (R-VI-05) »
 * - R-VI-06 fin d'une visite avec sa cause ; demande close         → « fin d'une visite (R-VI-06) »
 * - R-FV-06 / RV-49 annulation par KSP ou agent absent            → « annulation par KSP (R-FV-06) »
 * - R-VI-08 clôture et absence par le back-office                 → « back-office (R-VI-08) »
 */
import { DomainRuleError } from '../requests/errors';
import { type VisitFee } from '../requests/visit-fee';
import {
  assertVisitPhotoLimit,
  assertVisitStart,
  canTransitionVisit,
  cancelVisit,
  cancelVisitByKsp,
  changeVisitSlot,
  completeVisit,
  completeVisitOnBehalf,
  earliestVisitStart,
  effectiveVisitStatus,
  markArrived,
  moveVisit,
  planVisit,
  reportClientAbsent,
  type Visit,
  visitAgendaWindow,
  VISIT_STATUSES,
} from './visit';

const at = (iso: string) => new Date(iso);
/** 10 h à Porto-Novo. */
const NOW = at('2026-11-20T09:00:00Z');
const CREATED = at('2026-11-20T07:00:00Z');

function thrown(fn: () => unknown): DomainRuleError {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainRuleError) return error;
    throw error;
  }
  throw new Error('aucune erreur levée');
}

const paidFee: VisitFee = {
  id: 'fee-1',
  rank: 1,
  amount: 5_000,
  status: 'paid',
  dueAt: null,
  paidAt: CREATED,
  refundedAt: null,
};

function visit(overrides: Partial<Visit> = {}): Visit {
  return {
    id: 'visit-1',
    attempt: 1,
    visitFeeId: 'fee-1',
    status: 'scheduled',
    scheduledStart: at('2026-11-22T09:00:00Z'),
    durationMinutes: 60,
    arrivedAt: null,
    completedAt: null,
    missedAt: null,
    missedPhotoFileId: null,
    cancelledAt: null,
    cancelCause: null,
    closedBy: null,
    closedReason: null,
    ...overrides,
  };
}

describe('transitions de 15.2', () => {
  it('scheduled → in_progress → completed ; manquée ou annulée depuis prévue ou en cours', () => {
    expect(canTransitionVisit('scheduled', 'in_progress')).toBe(true);
    expect(canTransitionVisit('in_progress', 'completed')).toBe(true);
    for (const from of ['scheduled', 'in_progress'] as const) {
      expect(canTransitionVisit(from, 'missed')).toBe(true);
      expect(canTransitionVisit(from, 'cancelled')).toBe(true);
    }
  });

  it('refuse le reste : pas de clôture sans arrivée, statuts finaux figés', () => {
    expect(canTransitionVisit('scheduled', 'completed')).toBe(false);
    for (const from of ['completed', 'missed', 'cancelled'] as const) {
      for (const to of VISIT_STATUSES) expect(canTransitionVisit(from, to)).toBe(false);
    }
  });
});

describe('planification (R-VI-01)', () => {
  it('au plus tôt la plus tardive de : demande + 24 h, et maintenant', () => {
    expect(earliestVisitStart(CREATED, NOW, 24)).toEqual(at('2026-11-21T07:00:00Z'));
    expect(earliestVisitStart(at('2026-11-10T07:00:00Z'), NOW, 24)).toEqual(NOW);
  });

  it('borne exacte : demande + 24 h acceptée, une milliseconde avant refusée', () => {
    expect(() => assertVisitStart(at('2026-11-21T07:00:00Z'), CREATED, NOW, 24)).not.toThrow();
    const error = thrown(() => assertVisitStart(at('2026-11-21T06:59:59.999Z'), CREATED, NOW, 24));
    expect(error.code).toBe('CLEANING_LEAD_TIME_TOO_SHORT');
    expect(error.details).toEqual({ minimumHours: 24 });
  });

  it('jamais dans le passé', () => {
    const old = at('2026-11-10T07:00:00Z');
    expect(thrown(() => assertVisitStart(at('2026-11-20T08:59:59Z'), old, NOW, 24)).details).toEqual({
      reason: 'in_past',
    });
    expect(() => assertVisitStart(NOW, old, NOW, 24)).not.toThrow();
  });

  it('planifie une visite couverte par les frais payés', () => {
    const result = planVisit({
      id: 'visit-1',
      attempt: 1,
      requestStatus: 'visit_to_schedule',
      fees: [paidFee],
      start: at('2026-11-22T09:00:00Z'),
      durationMinutes: 60,
      requestCreatedAt: CREATED,
      minLeadHours: 24,
      now: NOW,
    });
    expect(result.requestStatus).toBe('visit_scheduled');
    expect(result.visit).toMatchObject({ status: 'scheduled', visitFeeId: 'fee-1', durationMinutes: 60 });
  });

  it('refuse sans frais payés, ou hors de « visite à planifier »', () => {
    const base = {
      id: 'visit-1',
      attempt: 1,
      start: at('2026-11-22T09:00:00Z'),
      durationMinutes: 60,
      requestCreatedAt: CREATED,
      minLeadHours: 24,
      now: NOW,
    };
    const pending = { ...paidFee, status: 'awaiting_payment' as const, paidAt: null };
    expect(
      thrown(() => planVisit({ ...base, requestStatus: 'awaiting_visit_fee', fees: [pending] })).code,
    ).toBe('CLEANING_INVALID_TRANSITION');
    expect(
      thrown(() => planVisit({ ...base, requestStatus: 'visit_to_schedule', fees: [pending] })).code,
    ).toBe('CLEANING_VISIT_FEE_UNPAID');
  });

  it('déplace une visite prévue, jamais une visite commencée', () => {
    const moved = moveVisit(visit(), at('2026-11-23T09:00:00Z'), CREATED, NOW, 24);
    expect(moved.scheduledStart).toEqual(at('2026-11-23T09:00:00Z'));
    const started = visit({ status: 'in_progress' });
    expect(thrown(() => moveVisit(started, at('2026-11-23T09:00:00Z'), CREATED, NOW, 24)).details).toEqual({
      from: 'in_progress',
      to: 'in_progress',
    });
  });
});

describe('agenda (R-VI-02)', () => {
  it('occupe la durée de la visite plus le trajet avant elle', () => {
    expect(visitAgendaWindow(at('2026-11-22T09:00:00Z'), 60, 30)).toEqual({
      from: at('2026-11-22T08:30:00Z'),
      to: at('2026-11-22T10:00:00Z'),
    });
  });
});

describe('autre créneau (R-VI-03)', () => {
  const slots = [{ start: at('2026-11-25T09:00:00Z'), end: at('2026-11-25T12:00:00Z') }];
  const base = {
    requestStatus: 'visit_scheduled' as const,
    slots,
    requestCreatedAt: CREATED,
    minLeadHours: 24,
    freeChangeHours: 24,
  };

  it('jusqu’à 24 h avant, borne incluse : visite annulée, demande à replanifier', () => {
    const result = changeVisitSlot({ ...base, visit: visit(), now: at('2026-11-21T09:00:00Z') });
    expect(result.visit).toMatchObject({ status: 'cancelled', cancelCause: 'slot_changed' });
    expect(result.requestStatus).toBe('visit_to_schedule');
    expect(result.slots).toBe(slots);
  });

  it('moins de 24 h avant : CLEANING_CANCELLATION_TOO_LATE', () => {
    expect(
      thrown(() => changeVisitSlot({ ...base, visit: visit(), now: at('2026-11-21T09:00:00.001Z') })).code,
    ).toBe('CLEANING_CANCELLATION_TOO_LATE');
  });

  it('seulement pour une visite planifiée', () => {
    expect(
      thrown(() => changeVisitSlot({ ...base, requestStatus: 'visit_done', visit: visit(), now: NOW }))
        .details,
    ).toEqual({ from: 'visit_done', to: 'visit_to_schedule' });
  });
});

describe('constat pas avant l’heure (R-VI-04)', () => {
  const start = at('2026-11-22T09:00:00Z');
  const arrived = markArrived(visit(), at('2026-11-22T08:50:00Z'));

  it('l’agent marque son arrivée : visite en cours', () => {
    expect(arrived).toMatchObject({ status: 'in_progress', arrivedAt: at('2026-11-22T08:50:00Z') });
  });

  it('clôture à l’heure prévue exacte : visite faite', () => {
    const result = completeVisit(arrived, start);
    expect(result.visit).toMatchObject({ status: 'completed', completedAt: start });
    expect(result.requestStatus).toBe('visit_done');
  });

  it('une milliseconde avant l’heure : CLEANING_VISIT_TOO_EARLY avec le fuseau', () => {
    const error = thrown(() => completeVisit(arrived, at('2026-11-22T08:59:59.999Z')));
    expect(error.code).toBe('CLEANING_VISIT_TOO_EARLY');
    expect(error.details).toEqual({ scheduledAt: '2026-11-22T09:00:00.000Z', timeZone: 'Africa/Porto-Novo' });
  });

  it('heure réelle entre l’arrivée et maintenant', () => {
    const now = at('2026-11-22T10:00:00Z');
    expect(completeVisit(arrived, now, at('2026-11-22T09:30:00Z')).visit.completedAt).toEqual(
      at('2026-11-22T09:30:00Z'),
    );
    expect(thrown(() => completeVisit(arrived, now, at('2026-11-22T10:00:00.001Z'))).details).toEqual({
      field: 'occurredAt',
      reason: 'in_future',
    });
    const lateArrival = markArrived(visit(), at('2026-11-22T09:20:00Z'));
    expect(thrown(() => completeVisit(lateArrival, now, at('2026-11-22T09:10:00Z'))).details).toEqual({
      field: 'occurredAt',
      reason: 'out_of_range',
    });
    expect(
      thrown(() => completeVisit(arrived, at('2026-11-26T09:30:00Z'), at('2026-11-22T09:29:59Z'))).details,
    ).toEqual({
      field: 'occurredAt',
      reason: 'too_old',
    });
  });

  it('pas de clôture sans arrivée', () => {
    expect(thrown(() => completeVisit(visit(), at('2026-11-22T10:00:00Z'))).details).toEqual({
      from: 'scheduled',
      to: 'completed',
    });
  });
});

describe('photos (R-VI-04)', () => {
  it('10 photos au plus', () => {
    expect(() => assertVisitPhotoLimit(9)).not.toThrow();
    const error = thrown(() => assertVisitPhotoLimit(10));
    expect(error.code).toBe('CLEANING_PHOTO_LIMIT_REACHED');
    expect(error.details).toEqual({ kind: 'visit', maximum: 10 });
  });
});

describe('client absent (R-VI-05)', () => {
  const input = {
    requestStatus: 'visit_scheduled' as const,
    fees: [paidFee],
    newFee: { id: 'fee-2', amount: 6_000 },
    paymentHours: 72,
  };

  it('visite manquée, frais conservés, nouveaux frais de rang 2 à payer sous 72 h', () => {
    const now = at('2026-11-22T09:40:00Z');
    const result = reportClientAbsent({
      ...input,
      visit: markArrived(visit(), now),
      photoFileId: 'photo-1',
      now,
    });
    expect(result.visit).toMatchObject({ status: 'missed', missedAt: now, missedPhotoFileId: 'photo-1' });
    expect(result.requestStatus).toBe('awaiting_visit_fee');
    expect(result.fees).toEqual([
      { ...paidFee, status: 'retained' },
      {
        id: 'fee-2',
        rank: 2,
        amount: 6_000,
        status: 'awaiting_payment',
        dueAt: at('2026-11-25T09:40:00Z'),
        paidAt: null,
        refundedAt: null,
      },
    ]);
  });

  it('photo du lieu obligatoire pour l’agent ; pas avant l’heure de la visite', () => {
    const now = at('2026-11-22T09:40:00Z');
    expect(
      thrown(() => reportClientAbsent({ ...input, visit: visit(), photoFileId: null, now })).details,
    ).toEqual({
      field: 'photoFileId',
      reason: 'required',
    });
    expect(
      thrown(() =>
        reportClientAbsent({ ...input, visit: visit(), photoFileId: 'p', now: at('2026-11-22T08:59:00Z') }),
      ).code,
    ).toBe('CLEANING_VISIT_TOO_EARLY');
  });
});

describe('annulation par KSP (R-FV-06)', () => {
  it.each(['ksp', 'agent_no_show'] as const)('%s : frais remboursés, demande à replanifier', (cause) => {
    const result = cancelVisitByKsp({
      visit: visit(),
      cause,
      requestStatus: 'visit_scheduled',
      fees: [paidFee],
      now: NOW,
    });
    expect(result.visit).toMatchObject({ status: 'cancelled', cancelCause: cause, cancelledAt: NOW });
    expect(result.requestStatus).toBe('visit_to_schedule');
    expect(result.refunded).toBe(5_000);
    expect(result.fees[0]).toMatchObject({ status: 'refunded', refundedAt: NOW });
  });

  it('visite gratuite annulée à son tour : rien à rembourser deux fois', () => {
    const refunded = { ...paidFee, status: 'refunded' as const, refundedAt: CREATED };
    const result = cancelVisitByKsp({
      visit: visit(),
      cause: 'ksp',
      requestStatus: 'visit_scheduled',
      fees: [refunded],
      now: NOW,
    });
    expect(result.refunded).toBe(0);
  });

  it('une visite faite ne s’annule plus', () => {
    const done = visit({ status: 'completed' });
    expect(
      thrown(() =>
        cancelVisitByKsp({
          visit: done,
          cause: 'ksp',
          requestStatus: 'visit_done',
          fees: [paidFee],
          now: NOW,
        }),
      ).details,
    ).toEqual({
      from: 'completed',
      to: 'cancelled',
    });
  });
});

describe('fin d’une visite (R-VI-06)', () => {
  it.each(['request_cancelled', 'request_rejected'] as const)('annulée avec sa cause : %s', (cause) => {
    expect(cancelVisit(visit({ status: 'in_progress' }), cause, NOW)).toMatchObject({
      status: 'cancelled',
      cancelCause: cause,
      cancelledAt: NOW,
    });
  });

  it('la visite vivante d’une demande close est affichée annulée', () => {
    expect(effectiveVisitStatus(visit(), 'cancelled')).toBe('cancelled');
    expect(effectiveVisitStatus(visit({ status: 'in_progress' }), 'rejected')).toBe('cancelled');
    expect(effectiveVisitStatus(visit(), 'visit_scheduled')).toBe('scheduled');
    expect(effectiveVisitStatus(visit({ status: 'missed' }), 'cancelled')).toBe('missed');
  });
});

describe('back-office (R-VI-08)', () => {
  const now = at('2026-11-22T12:00:00Z');

  it('clôture pour l’agent, avec un motif, à l’heure réelle', () => {
    const result = completeVisitOnBehalf(visit(), {
      staffId: 'sup-1',
      reason: 'Agent sans réseau',
      completedAt: at('2026-11-22T10:00:00Z'),
      now,
    });
    expect(result.visit).toMatchObject({
      status: 'completed',
      completedAt: at('2026-11-22T10:00:00Z'),
      closedBy: 'sup-1',
      closedReason: 'Agent sans réseau',
    });
    expect(result.requestStatus).toBe('visit_done');
  });

  it('motif obligatoire, heure réelle ni future ni avant l’heure de la visite', () => {
    const base = { staffId: 'sup-1', reason: 'Appel', now };
    expect(thrown(() => completeVisitOnBehalf(visit(), { ...base, reason: '', completedAt: now })).code).toBe(
      'CLEANING_REASON_REQUIRED',
    );
    expect(
      thrown(() => completeVisitOnBehalf(visit(), { ...base, completedAt: at('2026-11-22T12:00:00.001Z') }))
        .details,
    ).toEqual({ field: 'occurredAt', reason: 'in_future' });
    expect(
      thrown(() => completeVisitOnBehalf(visit(), { ...base, completedAt: at('2026-11-22T08:00:00Z') })).code,
    ).toBe('CLEANING_VISIT_TOO_EARLY');
  });

  it('absence signalée par le back-office : photo facultative, motif obligatoire', () => {
    const result = reportClientAbsent({
      visit: visit(),
      requestStatus: 'visit_scheduled',
      fees: [paidFee],
      newFee: { id: 'fee-2', amount: 5_000 },
      paymentHours: 72,
      photoFileId: null,
      staff: { id: 'sup-1', reason: 'Client injoignable' },
      now,
    });
    expect(result.visit).toMatchObject({ status: 'missed', closedBy: 'sup-1', missedPhotoFileId: null });
    expect(() =>
      reportClientAbsent({
        visit: visit(),
        requestStatus: 'visit_scheduled',
        fees: [paidFee],
        newFee: { id: 'fee-2', amount: 5_000 },
        paymentHours: 72,
        photoFileId: null,
        staff: { id: 'sup-1', reason: ' ' },
        now,
      }),
    ).toThrow(DomainRuleError);
  });
});
