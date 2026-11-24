import { DomainRuleError } from './errors';
import { defaultVisitSlot, submitFollowUpRequest } from './follow-up-request';

const NOW = new Date('2026-11-24T10:00:00Z');
const input = {
  openCount: 0,
  maxOpenRequests: 3,
  organizationSuspended: false,
  withVisit: false,
  feeId: 'fee-1',
  feeAmount: 5_000,
  paymentHours: 24,
  now: NOW,
};

function thrown(fn: () => unknown): DomainRuleError {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainRuleError) return error;
    throw error;
  }
  throw new Error('aucune erreur levée');
}

describe('demande née d’un programme (R-PG-07, R-PG-08)', () => {
  it('sans visite : devis à composer, aucuns frais', () => {
    expect(submitFollowUpRequest(input)).toEqual({ status: 'visit_done', fee: null });
  });

  it('avec visite : frais de rang 1 à payer avant l’échéance des réglages', () => {
    expect(submitFollowUpRequest({ ...input, withVisit: true })).toEqual({
      status: 'awaiting_visit_fee',
      fee: {
        id: 'fee-1',
        rank: 1,
        amount: 5_000,
        status: 'awaiting_payment',
        dueAt: new Date('2026-11-25T10:00:00Z'),
        paidAt: null,
        refundedAt: null,
      },
    });
  });

  it('plafond des demandes ouvertes et organisation suspendue : refusés', () => {
    const full = thrown(() => submitFollowUpRequest({ ...input, openCount: 3 }));
    expect(full.code).toBe('CLEANING_TOO_MANY_OPEN_REQUESTS');
    expect(full.details).toEqual({ maximum: 3 });
    expect(thrown(() => submitFollowUpRequest({ ...input, organizationSuspended: true })).code).toBe(
      'CLEANING_ORGANIZATION_SUSPENDED',
    );
  });

  it('créneau de visite par défaut : le premier matin après le délai minimum (Porto-Novo)', () => {
    // 24/11 à 11 h (Porto-Novo) + 24 h = 25/11 : le matin du 26/11, de 8 h à 12 h.
    expect(defaultVisitSlot(NOW, 24)).toEqual({
      start: new Date('2026-11-26T07:00:00Z'),
      end: new Date('2026-11-26T11:00:00Z'),
    });
  });
});
