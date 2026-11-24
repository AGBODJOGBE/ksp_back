/**
 * Validation du devis (partie 7.6) : acceptation, refus, transmission pour accord.
 *
 * Matrice règle → test :
 * - R-AC-01 programme confirmé, séances au prix d'une séance      → « acceptation (R-AC-01) »
 * - R-AC-01 date de début dans la limite de la validité (Porto-Novo) → « date de début (R-AC-01) »
 * - R-PG-03 première séance ≥ 48 h après l'acceptation             → « acceptation (R-AC-01) »
 * - R-FV-05 frais déduits de la première séance, reste ensuite     → « acceptation (R-AC-01) »
 * - R-AC-02 seul l'administrateur accepte ou refuse                → « organisation (R-AC-02) »
 * - R-AC-02 / RV-86 seuil d'impayés atteint : acceptation refusée  → « organisation (R-AC-02) »
 * - CLEANING_ORGANIZATION_SUSPENDED à l'acceptation                → « organisation (R-AC-02) »
 * - RV-14 devis périmé : QUOTE_EXPIRED à l'acceptation, borne exacte → « devis périmé ou retiré »
 * - RV-50 devis retiré : ni accepté ni refusé                       → « devis périmé ou retiré »
 * - R-AC-03 refus avec motif de la liste, frais conservés          → « refus (R-AC-03) »
 * - R-AC-02 transmission par un membre, devis périmé refusé        → « transmission (R-AC-02) »
 */
import { DomainRuleError } from '../requests/errors';
import { type VisitFee } from '../requests/visit-fee';
import { acceptQuote, declineQuote, forwardQuote, type OrganizationStanding } from './acceptance';
import { composeQuote, type Quote, sendQuote } from './quote';

const at = (iso: string) => new Date(iso);
const SENT_AT = at('2026-11-22T12:00:00Z');
const NOW = at('2026-11-23T12:00:00Z');

function thrown(fn: () => unknown): DomainRuleError {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainRuleError) return error;
    throw error;
  }
  throw new Error('aucune erreur levée');
}

function sentQuote(sentAt = SENT_AT, overrides: Partial<Parameters<typeof composeQuote>[0]> = {}): Quote {
  const draft = composeQuote({
    id: 'quote-1',
    requestId: 'req-1',
    version: 1,
    requestStatus: 'visit_done',
    retainedRevision: 1,
    lines: [
      {
        offerId: 'o',
        cleaningTypeId: 'floor',
        name: 'Sol',
        quantity: 1,
        unitPrice: 3_000,
        amount: 3_000,
        kind: 'offer',
      },
    ],
    basePrice: 3_000,
    adjustments: [],
    sessionStarts: [at('2026-11-26T12:00:00Z'), at('2026-12-03T12:00:00Z'), at('2026-12-10T12:00:00Z')],
    teamSize: 1,
    durationMinutes: 120,
    paymentTerms: 'per_session',
    termsVersion: 'cg-2026-11',
    deductibleVisitFee: 5_000,
    discountApprovalThresholdPercent: 20,
    firstSessionLeadHours: 48,
    createdBy: 'sup-1',
    now: sentAt,
    ...overrides,
  });
  return sendQuote({
    quote: draft,
    requestStatus: 'visit_done',
    previous: null,
    validityDays: 15,
    firstSessionLeadHours: 48,
    now: sentAt,
  }).quote;
}

const paidFee: VisitFee = {
  id: 'fee-1',
  rank: 1,
  amount: 5_000,
  status: 'paid',
  dueAt: null,
  paidAt: SENT_AT,
  refundedAt: null,
};
const admin: OrganizationStanding = {
  role: 'org_admin',
  suspended: false,
  unpaidInvoices: 0,
  unpaidInvoicesSuspension: 2,
};

function accept(overrides: Partial<Parameters<typeof acceptQuote>[0]> = {}) {
  return acceptQuote({
    quote: sentQuote(),
    requestStatus: 'quote_sent',
    organization: null,
    fees: [paidFee],
    firstSessionLeadHours: 48,
    userId: 'user-1',
    now: NOW,
    ...overrides,
  });
}

describe('acceptation (R-AC-01)', () => {
  it('programme confirmé, une séance par date au prix d’une séance, frais déduits', () => {
    const result = accept();
    expect(result.requestStatus).toBe('accepted');
    expect(result.quote).toMatchObject({ status: 'accepted', respondedAt: NOW, respondedBy: 'user-1' });
    expect(result.fees[0]?.status).toBe('deducted');
    expect(result.program).toEqual({
      status: 'confirmed',
      payerKind: 'individual',
      quoteId: 'quote-1',
      total: 9_000,
      visitFeeDeduction: 5_000,
      sessions: [
        {
          rank: 1,
          scheduledStart: at('2026-11-26T12:00:00Z'),
          price: 3_000,
          visitFeeDeduction: 3_000,
          status: 'to_assign',
        },
        {
          rank: 2,
          scheduledStart: at('2026-12-03T12:00:00Z'),
          price: 3_000,
          visitFeeDeduction: 2_000,
          status: 'to_assign',
        },
        {
          rank: 3,
          scheduledStart: at('2026-12-10T12:00:00Z'),
          price: 3_000,
          visitFeeDeduction: 0,
          status: 'to_assign',
        },
      ],
    });
  });

  it('sans déduction prévue au devis : frais conservés, aucune séance réduite', () => {
    const result = accept({ quote: sentQuote(SENT_AT, { deductibleVisitFee: 0 }) });
    expect(result.fees[0]?.status).toBe('retained');
    expect(result.program.sessions.map((session) => session.visitFeeDeduction)).toEqual([0, 0, 0]);
  });

  it('entreprise : facture mensuelle, payeur organisation', () => {
    const result = accept({
      quote: sentQuote(SENT_AT, { paymentTerms: 'monthly_invoice' }),
      organization: admin,
    });
    expect(result.program.payerKind).toBe('organization');
  });

  it('borne R-PG-03 : première séance 48 h après l’acceptation exactement ; une milliseconde avant refusée', () => {
    expect(() => accept({ now: at('2026-11-24T12:00:00Z') })).not.toThrow();
    const error = thrown(() => accept({ now: at('2026-11-24T12:00:00.001Z') }));
    expect(error.code).toBe('CLEANING_LEAD_TIME_TOO_SHORT');
  });

  it('refusée hors « devis envoyé »', () => {
    expect(thrown(() => accept({ requestStatus: 'cancelled' })).details).toEqual({
      from: 'cancelled',
      to: 'accepted',
    });
  });
});

describe('date de début (R-AC-01)', () => {
  // Envoyé à 0 h 30 le 23 à Porto-Novo : valable jusqu'au 8 décembre 0 h 30, heure locale.
  const lateQuote = () => sentQuote(at('2026-11-22T23:30:00Z'));
  const shifted = [at('2026-12-08T08:00:00Z')];

  it('décalée jusqu’au jour local de fin de validité inclus', () => {
    const result = accept({ quote: lateQuote(), startDate: '2026-12-08', sessionStarts: shifted });
    expect(result.quote.acceptedStartDate).toBe('2026-12-08');
    expect(result.program.sessions).toHaveLength(1);
    expect(result.program.total).toBe(3_000);
  });

  it('au-delà : refusée', () => {
    const error = thrown(() =>
      accept({ quote: lateQuote(), startDate: '2026-12-09', sessionStarts: shifted }),
    );
    expect(error.details).toEqual({ field: 'startDate', reason: 'out_of_range' });
  });
});

describe('organisation (R-AC-02)', () => {
  it('seul l’administrateur accepte', () => {
    expect(() => accept({ organization: admin })).not.toThrow();
    const error = thrown(() => accept({ organization: { ...admin, role: 'org_member' } }));
    expect(error.code).toBe('AUTH_FORBIDDEN');
    expect(error.details).toEqual({ organizationRole: 'org_member' });
  });

  it('impayés au seuil de suspension : refusée ; un de moins : acceptée', () => {
    const error = thrown(() => accept({ organization: { ...admin, unpaidInvoices: 2 } }));
    expect(error.code).toBe('CLEANING_ORGANIZATION_UNPAID_INVOICES');
    expect(error.details).toEqual({ unpaidCount: 2, threshold: 2 });
    expect(() => accept({ organization: { ...admin, unpaidInvoices: 1 } })).not.toThrow();
  });

  it('organisation suspendue : refusée', () => {
    expect(thrown(() => accept({ organization: { ...admin, suspended: true } })).code).toBe(
      'CLEANING_ORGANIZATION_SUSPENDED',
    );
  });
});

describe('devis périmé ou retiré', () => {
  it('à la date de validité exacte : CLEANING_QUOTE_EXPIRED ; une milliseconde avant : accepté', () => {
    const quote = sentQuote(at('2026-11-10T12:00:00Z'), {
      sessionStarts: [at('2026-11-26T12:00:00Z')],
    });
    expect(() =>
      accept({ quote, now: at('2026-11-25T11:59:59.999Z'), firstSessionLeadHours: 24 }),
    ).not.toThrow();
    expect(
      thrown(() => accept({ quote, now: at('2026-11-25T12:00:00Z'), firstSessionLeadHours: 24 })).code,
    ).toBe('CLEANING_QUOTE_EXPIRED');
    expect(thrown(() => accept({ quote: { ...quote, status: 'expired' } })).code).toBe(
      'CLEANING_QUOTE_EXPIRED',
    );
  });

  it.each(['withdrawn', 'superseded', 'declined'] as const)(
    'devis %s : CLEANING_INVALID_TRANSITION',
    (status) => {
      const quote = { ...sentQuote(), status };
      expect(thrown(() => accept({ quote })).details).toEqual({ from: status, to: 'accepted' });
      expect(
        thrown(() =>
          declineQuote({
            quote,
            requestStatus: 'quote_sent',
            role: null,
            fees: [paidFee],
            userId: 'u',
            now: NOW,
          }),
        ).code,
      ).toBe('CLEANING_INVALID_TRANSITION');
    },
  );
});

describe('refus (R-AC-03)', () => {
  const base = { requestStatus: 'quote_sent' as const, fees: [paidFee], userId: 'user-1', now: NOW };

  it('motif de la liste et texte : dossier clos, frais conservés', () => {
    const result = declineQuote({
      ...base,
      quote: sentQuote(),
      role: 'org_admin',
      reasonCode: 'price',
      comment: 'Trop cher',
    });
    expect(result.requestStatus).toBe('declined');
    expect(result.quote).toMatchObject({
      status: 'declined',
      declineReasonCode: 'price',
      declineComment: 'Trop cher',
      respondedAt: NOW,
    });
    expect(result.fees[0]?.status).toBe('retained');
  });

  it('motif facultatif ; hors liste refusé ; membre refusé', () => {
    expect(declineQuote({ ...base, quote: sentQuote(), role: null }).quote.declineReasonCode).toBeNull();
    expect(
      thrown(() => declineQuote({ ...base, quote: sentQuote(), role: null, reasonCode: 'visit_fee' }))
        .details,
    ).toEqual({
      field: 'reasonCode',
      reason: 'unknown_choice',
    });
    expect(thrown(() => declineQuote({ ...base, quote: sentQuote(), role: 'org_member' })).code).toBe(
      'AUTH_FORBIDDEN',
    );
  });

  it('devis périmé : CLEANING_INVALID_TRANSITION', () => {
    const error = thrown(() =>
      declineQuote({ ...base, quote: sentQuote(), role: null, now: at('2026-12-07T12:00:00Z') }),
    );
    expect(error.details).toEqual({ from: 'expired', to: 'declined' });
  });
});

describe('transmission (R-AC-02)', () => {
  it('un membre transmet un devis valable, rejouable sans effet', () => {
    const quote = sentQuote();
    expect(forwardQuote({ quote, role: 'org_member', now: NOW })).toBe(quote);
  });

  it('lecteur refusé ; devis périmé refusé', () => {
    expect(thrown(() => forwardQuote({ quote: sentQuote(), role: 'org_viewer', now: NOW })).code).toBe(
      'AUTH_FORBIDDEN',
    );
    expect(
      thrown(() => forwardQuote({ quote: sentQuote(), role: 'org_member', now: at('2026-12-07T12:00:00Z') }))
        .details,
    ).toEqual({
      from: 'expired',
      to: 'expired',
    });
  });
});
