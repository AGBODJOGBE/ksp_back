/**
 * Vie de la demande : envoi, annulation, refus par KSP, réactivation, correction de position.
 *
 * Matrice règle → test :
 * - R-DM-04 plafond à l'envoi                                   → « envoi »
 * - R-DM-05 / 7.1 créneaux (1 à 3, pas dans le passé, délai)   → « créneaux de visite »
 * - R-FV-02 débit à l'envoi ou attente du paiement              → « envoi »
 * - CLEANING_ORGANIZATION_SUSPENDED à l'envoi                   → « envoi »
 * - R-FV-03 annulation automatique à 72 h, borne exacte         → « annulation automatique »
 * - partie 12 / R-FV-06 annulation par le client, 24 h          → « annulation par le client »
 * - R-VI-06 visite vivante annulée avec sa cause                → « annulation par le client », « refus par KSP »
 * - R-AC-05 refus par KSP, motif, remboursement sans visite     → « refus par KSP »
 * - R-AC-04 réactivation demandée, acceptée, refusée            → « réactivation »
 * - R-DM-07 / RV-38 correction de position, commune verrouillée → « correction de position »
 */
import { DomainRuleError } from './errors';
import {
  assertLocationCorrection,
  cancelForUnpaidVisitFee,
  cancelRequestByClient,
  type CaseVisit,
  decideReactivation,
  rejectRequest,
  requestReactivation,
  submitRequest,
  validateVisitSlots,
} from './request-lifecycle';
import { type VisitFee } from './visit-fee';

const at = (iso: string) => new Date(iso);
/** 10 h à Porto-Novo. */
const NOW = at('2026-11-20T09:00:00Z');

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
  paidAt: at('2026-11-18T09:00:00Z'),
  refundedAt: null,
};

function visit(overrides: Partial<CaseVisit> = {}): CaseVisit {
  return {
    visitFeeId: 'fee-1',
    status: 'scheduled',
    scheduledStart: at('2026-11-22T09:00:00Z'),
    ...overrides,
  };
}

describe('créneaux de visite', () => {
  const slot = (start: string, end: string) => ({ start: at(start), end: at(end) });
  const ok = slot('2026-11-21T09:00:00Z', '2026-11-21T12:00:00Z');

  it('accepte 1 à 3 créneaux qui finissent après le délai minimum', () => {
    expect(() => validateVisitSlots([ok], NOW, 24)).not.toThrow();
    expect(() => validateVisitSlots([ok, ok, ok], NOW, 24)).not.toThrow();
  });

  it('refuse 0 ou plus de 3 créneaux, un créneau mal formé ou passé', () => {
    expect(thrown(() => validateVisitSlots([], NOW, 24)).details).toEqual({ reason: 'malformed' });
    expect(thrown(() => validateVisitSlots([ok, ok, ok, ok], NOW, 24)).details).toEqual({
      reason: 'too_many',
    });
    const reversed = slot('2026-11-21T12:00:00Z', '2026-11-21T09:00:00Z');
    expect(thrown(() => validateVisitSlots([reversed], NOW, 24)).code).toBe('CLEANING_SLOT_INVALID');
    const past = slot('2026-11-20T08:59:00Z', '2026-11-22T12:00:00Z');
    expect(thrown(() => validateVisitSlots([past], NOW, 24)).details).toEqual({ reason: 'in_past' });
  });

  it('borne R-DM-05 : un créneau qui finit à demande + 24 h exactement est inutilisable', () => {
    const tooShort = slot('2026-11-20T10:00:00Z', '2026-11-21T09:00:00Z');
    const error = thrown(() => validateVisitSlots([tooShort], NOW, 24));
    expect(error.code).toBe('CLEANING_LEAD_TIME_TOO_SHORT');
    expect(error.details).toEqual({ minimumHours: 24 });
    const justEnough = slot('2026-11-20T10:00:00Z', '2026-11-21T09:00:00.001Z');
    expect(() => validateVisitSlots([justEnough], NOW, 24)).not.toThrow();
  });
});

describe('envoi', () => {
  const base = {
    openCount: 0,
    maxOpenRequests: 5,
    organizationSuspended: false,
    slots: [{ start: at('2026-11-22T09:00:00Z'), end: at('2026-11-22T12:00:00Z') }],
    minVisitLeadHours: 24,
    feeId: 'fee-1',
    feeAmount: 5_000,
    paymentHours: 72,
    now: NOW,
  };

  it('frais débités du wallet : « visite à planifier », frais payés de rang 1', () => {
    const result = submitRequest({ ...base, walletDebited: true });
    expect(result.status).toBe('visit_to_schedule');
    expect(result.fee).toMatchObject({ rank: 1, status: 'paid', paidAt: NOW, dueAt: null });
  });

  it('solde insuffisant : la demande attend le paiement, échéance 72 h', () => {
    const result = submitRequest({ ...base, walletDebited: false });
    expect(result.status).toBe('awaiting_visit_fee');
    expect(result.fee).toMatchObject({ status: 'awaiting_payment', dueAt: at('2026-11-23T09:00:00Z') });
  });

  it('refuse au plafond de demandes ouvertes et pour une organisation suspendue', () => {
    expect(thrown(() => submitRequest({ ...base, walletDebited: true, openCount: 5 })).code).toBe(
      'CLEANING_TOO_MANY_OPEN_REQUESTS',
    );
    expect(
      thrown(() => submitRequest({ ...base, walletDebited: true, organizationSuspended: true })).code,
    ).toBe('CLEANING_ORGANIZATION_SUSPENDED');
  });
});

describe('annulation automatique (R-FV-03)', () => {
  const pending: VisitFee = {
    ...paidFee,
    status: 'awaiting_payment',
    paidAt: null,
    dueAt: at('2026-11-23T09:00:00Z'),
  };

  it('à l’échéance exacte, la demande est annulée', () => {
    expect(cancelForUnpaidVisitFee('awaiting_visit_fee', pending, at('2026-11-23T09:00:00Z'))).toEqual({
      requestStatus: 'cancelled',
      cause: 'visit_fee_unpaid',
    });
  });

  it('une milliseconde avant, rien n’est annulé', () => {
    const error = thrown(() =>
      cancelForUnpaidVisitFee('awaiting_visit_fee', pending, at('2026-11-23T08:59:59.999Z')),
    );
    expect(error.details).toEqual({ from: 'awaiting_visit_fee', to: 'cancelled' });
  });

  it('des frais payés n’annulent rien', () => {
    expect(thrown(() => cancelForUnpaidVisitFee('visit_to_schedule', paidFee, NOW)).code).toBe(
      'CLEANING_INVALID_TRANSITION',
    );
  });
});

describe('annulation par le client', () => {
  const input = { fees: [paidFee], freeCancellationHours: 24, now: NOW };

  it('plus de 24 h avant la visite : frais remboursés, visite annulée', () => {
    const result = cancelRequestByClient({
      ...input,
      request: { status: 'visit_scheduled' },
      visits: [visit({ scheduledStart: at('2026-11-21T09:00:00.001Z') })],
      reasonCode: 'found_other_provider',
    });
    expect(result.requestStatus).toBe('cancelled');
    expect(result.refunded).toBe(5_000);
    expect(result.fees[0]?.status).toBe('refunded');
    expect(result.visitCancelCause).toBe('request_cancelled');
    expect(result.reasonCode).toBe('found_other_provider');
  });

  it('borne : 24 h avant exactement, frais conservés', () => {
    const result = cancelRequestByClient({
      ...input,
      request: { status: 'visit_scheduled' },
      visits: [visit({ scheduledStart: at('2026-11-21T09:00:00Z') })],
    });
    expect(result.refunded).toBe(0);
    expect(result.fees[0]?.status).toBe('retained');
  });

  it('sans visite planifiée : remboursés ; frais non payés : rien à rendre', () => {
    const toSchedule = cancelRequestByClient({
      ...input,
      request: { status: 'visit_to_schedule' },
      visits: [],
    });
    expect(toSchedule.refunded).toBe(5_000);
    expect(toSchedule.visitCancelCause).toBeNull();
    const pending: VisitFee = {
      ...paidFee,
      status: 'awaiting_payment',
      paidAt: null,
      dueAt: at('2026-11-23T09:00:00Z'),
    };
    const unpaid = cancelRequestByClient({
      ...input,
      fees: [pending],
      request: { status: 'awaiting_visit_fee', pendingVisitFeeDueAt: pending.dueAt },
      visits: [],
    });
    expect(unpaid.refunded).toBe(0);
    expect(unpaid.fees[0]?.status).toBe('awaiting_payment');
  });

  it('après la visite (devis envoyé, ou visite en cours) : frais conservés', () => {
    const afterVisit = cancelRequestByClient({
      ...input,
      request: { status: 'quote_sent', sentQuoteValidUntil: at('2026-12-05T09:00:00Z') },
      visits: [visit({ status: 'completed' })],
    });
    expect(afterVisit.fees[0]?.status).toBe('retained');
    const onSite = cancelRequestByClient({
      ...input,
      request: { status: 'visit_scheduled' },
      visits: [visit({ status: 'in_progress', scheduledStart: at('2026-11-20T08:00:00Z') })],
    });
    expect(onSite.refunded).toBe(0);
    expect(onSite.visitCancelCause).toBe('request_cancelled');
  });

  it('nouvelle visite gratuite demandée par KSP : une visite a eu lieu, frais conservés', () => {
    const result = cancelRequestByClient({
      ...input,
      request: { status: 'visit_to_schedule' },
      visits: [visit({ status: 'completed', scheduledStart: at('2026-11-19T09:00:00Z') })],
    });
    expect(result.refunded).toBe(0);
  });

  it('refuse un devis périmé, un dossier accepté, un motif hors liste', () => {
    const expired = { status: 'quote_sent' as const, sentQuoteValidUntil: NOW };
    expect(thrown(() => cancelRequestByClient({ ...input, request: expired, visits: [] })).details).toEqual({
      from: 'expired',
      to: 'cancelled',
    });
    expect(
      thrown(() => cancelRequestByClient({ ...input, request: { status: 'accepted' }, visits: [] })).code,
    ).toBe('CLEANING_INVALID_TRANSITION');
    const error = thrown(() =>
      cancelRequestByClient({ ...input, request: { status: 'visit_done' }, visits: [], reasonCode: 'price' }),
    );
    expect(error.details).toEqual({ field: 'reasonCode', reason: 'unknown_choice' });
  });
});

describe('refus par KSP (R-AC-05)', () => {
  const input = { fees: [paidFee], now: NOW, reasonCode: 'place_inaccessible', reason: 'Accès impossible' };

  it('avant toute visite : frais remboursés, visite prévue annulée', () => {
    const result = rejectRequest({ ...input, request: { status: 'visit_scheduled' }, visits: [visit()] });
    expect(result).toMatchObject({
      requestStatus: 'rejected',
      refunded: 5_000,
      visitCancelCause: 'request_rejected',
    });
    expect(result.reason).toBe('Accès impossible');
  });

  it('après une visite : frais conservés', () => {
    const result = rejectRequest({
      ...input,
      request: { status: 'visit_done' },
      visits: [visit({ status: 'completed' })],
    });
    expect(result.refunded).toBe(0);
    expect(result.fees[0]?.status).toBe('retained');
  });

  it('motif et code obligatoires, code dans la liste', () => {
    const request = { status: 'visit_done' as const };
    expect(thrown(() => rejectRequest({ ...input, request, visits: [], reason: '  ' })).code).toBe(
      'CLEANING_REASON_REQUIRED',
    );
    expect(
      thrown(() => rejectRequest({ ...input, request, visits: [], reasonCode: 'visit_fee' })).details,
    ).toEqual({
      field: 'reasonCode',
      reason: 'unknown_choice',
    });
    expect(thrown(() => rejectRequest({ ...input, request, visits: [], reasonCode: '' })).details).toEqual({
      field: 'reasonCode',
      reason: 'required',
    });
  });

  it('jamais après l’acceptation', () => {
    expect(
      thrown(() => rejectRequest({ ...input, request: { status: 'accepted' }, visits: [] })).details,
    ).toEqual({
      from: 'accepted',
      to: 'rejected',
    });
  });
});

describe('réactivation (R-AC-04)', () => {
  const expiredRequest = { status: 'quote_sent' as const, sentQuoteValidUntil: NOW };

  it('demandée sur un devis périmé, même avant le passage de la tâche', () => {
    expect(requestReactivation(expiredRequest, null, 'user-1', NOW)).toEqual({
      status: 'pending',
      requestedAt: NOW,
      requestedBy: 'user-1',
      decidedAt: null,
      decidedBy: null,
    });
  });

  it('rejouée sans effet tant qu’une demande est en attente', () => {
    const pending = requestReactivation(expiredRequest, null, 'user-1', NOW);
    expect(requestReactivation(expiredRequest, pending, 'user-2', at('2026-11-21T09:00:00Z'))).toBe(pending);
  });

  it('refusée sur un devis encore valable', () => {
    const valid = { status: 'quote_sent' as const, sentQuoteValidUntil: at('2026-11-20T09:00:00.001Z') };
    expect(thrown(() => requestReactivation(valid, null, 'user-1', NOW)).details).toEqual({
      from: 'quote_sent',
      to: 'quote_sent',
    });
  });

  it('acceptée : le dossier repasse « visite faite » ; refusée : il reste expiré', () => {
    const pending = requestReactivation(expiredRequest, null, 'user-1', NOW);
    const accepted = decideReactivation(expiredRequest, pending, 'accept', 'sup-1', NOW);
    expect(accepted.requestStatus).toBe('visit_done');
    expect(accepted.reactivation).toMatchObject({ status: 'accepted', decidedBy: 'sup-1', decidedAt: NOW });
    const refused = decideReactivation(expiredRequest, pending, 'refuse', 'sup-1', NOW);
    expect(refused.requestStatus).toBe('expired');
    expect(refused.reactivation.status).toBe('refused');
  });

  it('rien à décider sans demande en attente, ni sur un dossier qui n’est plus expiré', () => {
    expect(thrown(() => decideReactivation(expiredRequest, null, 'accept', 'sup-1', NOW)).code).toBe(
      'CLEANING_INVALID_TRANSITION',
    );
    const pending = requestReactivation(expiredRequest, null, 'user-1', NOW);
    for (const decision of ['accept', 'refuse'] as const) {
      expect(
        thrown(() => decideReactivation({ status: 'visit_done' }, pending, decision, 'sup-1', NOW)).code,
      ).toBe('CLEANING_INVALID_TRANSITION');
    }
  });
});

describe('correction de position (R-DM-07)', () => {
  it('avant l’envoi du devis : permise, le retenu et les brouillons seront recalculés', () => {
    expect(
      assertLocationCorrection(
        { request: { status: 'visit_done' }, communeChanged: true, program: null },
        NOW,
      ),
    ).toEqual({
      recalculatePricing: true,
    });
    expect(
      assertLocationCorrection(
        { request: { status: 'visit_done' }, communeChanged: false, program: null },
        NOW,
      ),
    ).toEqual({
      recalculatePricing: false,
    });
  });

  it('commune changée alors qu’un devis est envoyé : refusée (commune_change_locked)', () => {
    const request = { status: 'quote_sent' as const, sentQuoteValidUntil: at('2026-12-05T09:00:00Z') };
    const error = thrown(() =>
      assertLocationCorrection({ request, communeChanged: true, program: null }, NOW),
    );
    expect(error.details).toEqual({ from: 'quote_sent', to: 'quote_sent', reason: 'commune_change_locked' });
    expect(assertLocationCorrection({ request, communeChanged: false, program: null }, NOW)).toEqual({
      recalculatePricing: false,
    });
  });

  it('programme en cours : même commune permise, commune changée refusée', () => {
    const request = { status: 'accepted' as const };
    const program = { status: 'in_progress' as const };
    expect(() => assertLocationCorrection({ request, communeChanged: false, program }, NOW)).not.toThrow();
    expect(
      thrown(() => assertLocationCorrection({ request, communeChanged: true, program }, NOW)).details,
    ).toMatchObject({
      reason: 'commune_change_locked',
    });
  });

  it('dossier clos ou programme terminé : refusée', () => {
    expect(
      thrown(() =>
        assertLocationCorrection(
          { request: { status: 'declined' }, communeChanged: false, program: null },
          NOW,
        ),
      ).details,
    ).toEqual({
      from: 'declined',
      to: 'declined',
    });
    const done = {
      request: { status: 'accepted' as const },
      communeChanged: false,
      program: { status: 'completed' as const },
    };
    expect(thrown(() => assertLocationCorrection(done, NOW)).code).toBe('CLEANING_INVALID_TRANSITION');
  });
});
