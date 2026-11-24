/**
 * Devis (partie 7.5) : composition, remise, envoi, révision, expiration, rappel, retrait.
 *
 * Matrice règle → test :
 * - R-DV-01 / RV-55 dates recalculées, première séance ≥ 48 h      → « composition (R-DV-01) »
 * - R-DV-01 / R-FV-05 frais de visite déduits, plafonnés au total   → « composition (R-DV-01) »
 * - R-DV-03 remise motivée, prix d'une séance strictement positif   → « remise manuelle (R-DV-03) »
 * - R-DV-03 plus de 20 % : validation d'un admin, borne exacte      → « remise manuelle (R-DV-03) »
 * - R-DV-03 validation par une autre personne que l'auteur          → « remise manuelle (R-DV-03) »
 * - R-DV-07 / RV-22 somme des lignes et ajustements à l'envoi       → « envoi (R-DV-02, R-DV-04) »
 * - R-DV-02 / R-DV-04 prix figé, validité 15 jours                   → « envoi (R-DV-02, R-DV-04) »
 * - R-DV-05 / R-CS-03 révision : l'ancien reste acceptable puis superseded → « révision (R-DV-05) »
 * - R-DV-04 / RV-53 rappel 2 jours avant, 0 = aucun, une fois      → « rappel (R-DV-04) »
 * - R-AC-04 / 15.2 expiration à la date de validité exacte          → « expiration (R-AC-04) »
 * - R-VI-07 / RV-50 nouvelle visite : devis retiré, motif           → « nouvelle visite (R-VI-07) »
 */
import { DomainRuleError } from '../requests/errors';
import { type VisitFee } from '../requests/visit-fee';
import {
  approveAdjustments,
  composeQuote,
  effectiveQuoteStatus,
  expireQuote,
  markReminded,
  type PricedLine,
  type Quote,
  type QuoteComposition,
  isReminderDue,
  requestNewVisit,
  withdrawOnRequestClosed,
  sendQuote,
  updateQuoteDraft,
} from './quote';

const at = (iso: string) => new Date(iso);
/** 13 h à Porto-Novo. */
const NOW = at('2026-11-22T12:00:00Z');

function thrown(fn: () => unknown): DomainRuleError {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainRuleError) return error;
    throw error;
  }
  throw new Error('aucune erreur levée');
}

const LINES: PricedLine[] = [
  {
    offerId: 'o-floor',
    cleaningTypeId: 'floor',
    name: 'Sol',
    quantity: 150,
    unit: 'm²',
    unitPrice: 120,
    amount: 18_000,
    kind: 'offer',
  },
  {
    offerId: 'o-win',
    cleaningTypeId: 'windows',
    name: 'Vitres',
    quantity: 1,
    unitPrice: 6_000,
    amount: 6_000,
    kind: 'offer',
  },
  {
    offerId: 'o-pack',
    cleaningTypeId: 'pack',
    name: 'Remise pack',
    quantity: 1,
    unitPrice: -600,
    amount: -600,
    kind: 'pack_discount',
  },
];
const BASE_PRICE = 23_400;
const STARTS = [at('2026-11-24T12:00:00Z'), at('2026-12-01T12:00:00Z'), at('2026-12-08T12:00:00Z')];

function composition(overrides: Partial<QuoteComposition> = {}): QuoteComposition {
  return {
    id: 'quote-1',
    requestId: 'req-1',
    version: 1,
    requestStatus: 'visit_done',
    retainedRevision: 1,
    lines: LINES,
    basePrice: BASE_PRICE,
    adjustments: [],
    sessionStarts: STARTS,
    teamSize: 2,
    durationMinutes: 180,
    paymentTerms: 'per_session',
    termsVersion: 'cg-2026-11',
    deductibleVisitFee: 5_000,
    discountApprovalThresholdPercent: 20,
    firstSessionLeadHours: 48,
    createdBy: 'sup-1',
    now: NOW,
    ...overrides,
  };
}

const sendSettings = { validityDays: 15, firstSessionLeadHours: 48 };

describe('composition (R-DV-01)', () => {
  it('prix d’une séance, nombre de séances, total, frais de visite déduits', () => {
    const quote = composeQuote(composition());
    expect(quote).toMatchObject({
      status: 'draft',
      sessionPrice: 23_400,
      sessionsCount: 3,
      total: 70_200,
      visitFeeDeduction: 5_000,
      validUntil: null,
      retainedRevision: 1,
    });
  });

  it('déduction plafonnée au total du programme', () => {
    const quote = composeQuote(composition({ deductibleVisitFee: 90_000 }));
    expect(quote.visitFeeDeduction).toBe(70_200);
  });

  it('première séance 48 h après maintenant exactement : acceptée ; une milliseconde avant : refusée', () => {
    expect(() => composeQuote(composition({ sessionStarts: [at('2026-11-24T12:00:00Z')] }))).not.toThrow();
    const error = thrown(() =>
      composeQuote(composition({ sessionStarts: [at('2026-11-24T11:59:59.999Z')] })),
    );
    expect(error.code).toBe('CLEANING_LEAD_TIME_TOO_SHORT');
    expect(error.details).toEqual({ minimumHours: 48 });
  });

  it('taille d’équipe d’au moins 1', () => {
    expect(thrown(() => composeQuote(composition({ teamSize: 0 }))).details).toEqual({
      field: 'teamSize',
      reason: 'out_of_range',
    });
  });

  it('programme sans date : CLEANING_SCHEDULE_EMPTY ; dossier hors « visite faite » refusé', () => {
    expect(thrown(() => composeQuote(composition({ sessionStarts: [] }))).code).toBe(
      'CLEANING_SCHEDULE_EMPTY',
    );
    expect(thrown(() => composeQuote(composition({ requestStatus: 'visit_scheduled' }))).details).toEqual({
      from: 'visit_scheduled',
      to: 'visit_scheduled',
    });
  });
});

describe('remise manuelle (R-DV-03)', () => {
  const discount = (percentBps: number) => ({
    kind: 'discount' as const,
    percentBps,
    reason: 'Client fidèle',
  });

  it('20 % exactement : pas de validation ; prix d’une séance diminué', () => {
    const quote = composeQuote(composition({ adjustments: [discount(2_000)] }));
    expect(quote.adjustments[0]).toMatchObject({ amount: -4_680, approvalStatus: 'not_required' });
    expect(quote.sessionPrice).toBe(18_720);
  });

  it('plus de 20 % : validation d’un admin requise, en pourcentage ou en montant fixe', () => {
    const percent = composeQuote(composition({ adjustments: [discount(2_001)] }));
    expect(percent.adjustments[0]).toMatchObject({ amount: -4_682, approvalStatus: 'pending' });
    const fixed = composeQuote(
      composition({ adjustments: [{ kind: 'discount', fixedAmount: 4_681, reason: 'Geste' }] }),
    );
    expect(fixed.adjustments[0]?.approvalStatus).toBe('pending');
    const atLimit = composeQuote(
      composition({ adjustments: [{ kind: 'discount', fixedAmount: 4_680, reason: 'Geste' }] }),
    );
    expect(atLimit.adjustments[0]?.approvalStatus).toBe('not_required');
  });

  it('une majoration n’exige aucune validation', () => {
    const quote = composeQuote(
      composition({ adjustments: [{ kind: 'surcharge', fixedAmount: 2_000, reason: 'Accès difficile' }] }),
    );
    expect(quote.adjustments[0]).toMatchObject({ amount: 2_000, approvalStatus: 'not_required' });
    expect(quote.sessionPrice).toBe(25_400);
  });

  it('motif obligatoire, un seul mode, montant positif', () => {
    expect(
      thrown(() =>
        composeQuote(composition({ adjustments: [{ kind: 'discount', percentBps: 500, reason: ' ' }] })),
      ).code,
    ).toBe('CLEANING_REASON_REQUIRED');
    expect(
      thrown(() =>
        composeQuote(
          composition({ adjustments: [{ kind: 'discount', percentBps: 500, fixedAmount: 10, reason: 'x' }] }),
        ),
      ).details,
    ).toEqual({ field: 'adjustments', reason: 'required' });
    expect(
      thrown(() =>
        composeQuote(composition({ adjustments: [{ kind: 'discount', fixedAmount: 0, reason: 'x' }] })),
      ).details,
    ).toEqual({ field: 'adjustments', reason: 'out_of_range' });
  });

  it('le prix d’une séance reste strictement positif', () => {
    expect(thrown(() => composeQuote(composition({ adjustments: [discount(10_000)] }))).code).toBe(
      'CLEANING_PRICE_NOT_POSITIVE',
    );
    expect(() =>
      composeQuote(composition({ adjustments: [{ kind: 'discount', fixedAmount: 23_399, reason: 'x' }] })),
    ).not.toThrow();
  });

  it('validée par une autre personne que l’auteur', () => {
    const quote = composeQuote(composition({ adjustments: [discount(3_000)] }));
    expect(thrown(() => approveAdjustments(quote, 'sup-1')).code).toBe('CLEANING_SECOND_APPROVER_REQUIRED');
    const approved = approveAdjustments(quote, 'admin-1');
    expect(approved.adjustments[0]).toMatchObject({ approvalStatus: 'approved', approvedBy: 'admin-1' });
    expect(approveAdjustments(approved, 'admin-2')).toEqual(approved);
  });

  it('une modification du brouillon redemande la validation ; un devis envoyé ne se modifie plus', () => {
    const approved = approveAdjustments(
      composeQuote(composition({ adjustments: [discount(3_000)] })),
      'admin-1',
    );
    const updated = updateQuoteDraft(approved, { teamSize: 3 }, composition());
    expect(updated.teamSize).toBe(3);
    expect(updated.adjustments[0]?.approvalStatus).toBe('pending');
    const sent = sendQuote({
      quote: composeQuote(composition()),
      requestStatus: 'visit_done',
      previous: null,
      ...sendSettings,
      now: NOW,
    });
    expect(thrown(() => updateQuoteDraft(sent.quote, { teamSize: 3 }, composition())).details).toEqual({
      from: 'sent',
      to: 'sent',
    });
    expect(thrown(() => approveAdjustments(sent.quote, 'admin-1')).code).toBe('CLEANING_INVALID_TRANSITION');
  });
});

describe('envoi (R-DV-02, R-DV-04)', () => {
  it('prix figé, validité de 15 jours, la demande passe « devis envoyé »', () => {
    const result = sendQuote({
      quote: composeQuote(composition()),
      requestStatus: 'visit_done',
      previous: null,
      ...sendSettings,
      now: NOW,
    });
    expect(result.requestStatus).toBe('quote_sent');
    expect(result.quote).toMatchObject({
      status: 'sent',
      sentAt: NOW,
      validUntil: at('2026-12-07T12:00:00Z'),
    });
    expect(result.superseded).toBeNull();
  });

  it('remise en attente de validation : CLEANING_QUOTE_APPROVAL_REQUIRED', () => {
    const quote = composeQuote(
      composition({ adjustments: [{ kind: 'discount', percentBps: 3_000, reason: 'x' }] }),
    );
    expect(
      thrown(() =>
        sendQuote({ quote, requestStatus: 'visit_done', previous: null, ...sendSettings, now: NOW }),
      ).code,
    ).toBe('CLEANING_QUOTE_APPROVAL_REQUIRED');
  });

  it('somme des lignes différente du prix : lines_total_mismatch', () => {
    const quote = composeQuote(composition({ lines: LINES.slice(0, 2) }));
    expect(
      thrown(() =>
        sendQuote({ quote, requestStatus: 'visit_done', previous: null, ...sendSettings, now: NOW }),
      ).details,
    ).toEqual({
      field: 'lines',
      reason: 'lines_total_mismatch',
    });
  });

  it('dates recalculées à l’envoi : la première séance doit rester à 48 h', () => {
    const quote = composeQuote(composition());
    const later = at('2026-11-22T12:00:00.001Z');
    expect(
      thrown(() =>
        sendQuote({ quote, requestStatus: 'visit_done', previous: null, ...sendSettings, now: later }),
      ).code,
    ).toBe('CLEANING_LEAD_TIME_TOO_SHORT');
    const moved = [at('2026-11-25T12:00:00Z')];
    const result = sendQuote({
      quote,
      requestStatus: 'visit_done',
      previous: null,
      sessionStarts: moved,
      ...sendSettings,
      now: later,
    });
    expect(result.quote).toMatchObject({ sessionsCount: 1, total: 23_400, visitFeeDeduction: 5_000 });
  });

  it('dossier hors « visite faite » ou « devis envoyé » : refusé', () => {
    const quote = composeQuote(composition());
    expect(
      thrown(() =>
        sendQuote({ quote, requestStatus: 'visit_to_schedule', previous: null, ...sendSettings, now: NOW }),
      ).details,
    ).toEqual({
      from: 'visit_to_schedule',
      to: 'quote_sent',
    });
  });
});

describe('révision (R-DV-05)', () => {
  const first = sendQuote({
    quote: composeQuote(composition()),
    requestStatus: 'visit_done',
    previous: null,
    ...sendSettings,
    now: NOW,
  }).quote;

  it('l’envoi de la révision remplace le devis envoyé, qui reste dans l’historique', () => {
    const later = at('2026-11-23T12:00:00Z');
    const draft = composeQuote(
      composition({
        id: 'quote-2',
        version: 2,
        requestStatus: 'quote_sent',
        retainedRevision: 2,
        now: later,
        sessionStarts: [at('2026-11-26T12:00:00Z')],
      }),
    );
    expect(effectiveQuoteStatus(first, later)).toBe('sent');
    const result = sendQuote({
      quote: draft,
      requestStatus: 'quote_sent',
      previous: first,
      ...sendSettings,
      now: later,
    });
    expect(result.superseded).toMatchObject({ id: 'quote-1', status: 'superseded' });
    expect(result.quote).toMatchObject({
      status: 'sent',
      version: 2,
      validUntil: at('2026-12-08T12:00:00Z'),
    });
    expect(result.requestStatus).toBe('quote_sent');
  });

  it('pas de révision sans devis envoyé à remplacer', () => {
    const draft = composeQuote(composition({ id: 'quote-2', version: 2, requestStatus: 'quote_sent' }));
    expect(
      thrown(() =>
        sendQuote({ quote: draft, requestStatus: 'quote_sent', previous: null, ...sendSettings, now: NOW }),
      ).code,
    ).toBe('CLEANING_INVALID_TRANSITION');
  });
});

describe('rappel (R-DV-04)', () => {
  const sent = sendQuote({
    quote: composeQuote(composition()),
    requestStatus: 'visit_done',
    previous: null,
    ...sendSettings,
    now: NOW,
  }).quote;

  it('2 jours avant l’expiration exactement, puis jusqu’à l’expiration exclue', () => {
    expect(isReminderDue(sent, at('2026-12-05T11:59:59.999Z'), 2)).toBe(false);
    expect(isReminderDue(sent, at('2026-12-05T12:00:00Z'), 2)).toBe(true);
    expect(isReminderDue(sent, at('2026-12-07T11:59:59.999Z'), 2)).toBe(true);
    expect(isReminderDue(sent, at('2026-12-07T12:00:00Z'), 2)).toBe(false);
  });

  it('une seule fois, jamais avec 0, jamais pour un brouillon', () => {
    const reminded = markReminded(sent, at('2026-12-05T12:00:00Z'));
    expect(reminded.expiryRemindedAt).toEqual(at('2026-12-05T12:00:00Z'));
    expect(isReminderDue(reminded, at('2026-12-06T12:00:00Z'), 2)).toBe(false);
    expect(isReminderDue(sent, at('2026-12-06T12:00:00Z'), 0)).toBe(false);
    expect(isReminderDue(composeQuote(composition()), at('2026-12-06T12:00:00Z'), 2)).toBe(false);
  });
});

describe('expiration (R-AC-04)', () => {
  const sent = sendQuote({
    quote: composeQuote(composition()),
    requestStatus: 'visit_done',
    previous: null,
    ...sendSettings,
    now: NOW,
  }).quote;
  const fee: VisitFee = {
    id: 'fee-1',
    rank: 1,
    amount: 5_000,
    status: 'paid',
    dueAt: null,
    paidAt: NOW,
    refundedAt: null,
  };

  it('à la date de validité exacte : devis et dossier expirés, frais conservés', () => {
    const validUntil = at('2026-12-07T12:00:00Z');
    expect(effectiveQuoteStatus(sent, new Date(validUntil.getTime() - 1))).toBe('sent');
    expect(effectiveQuoteStatus(sent, validUntil)).toBe('expired');
    const result = expireQuote({ quote: sent, requestStatus: 'quote_sent', fees: [fee], now: validUntil });
    expect(result.quote.status).toBe('expired');
    expect(result.requestStatus).toBe('expired');
    expect(result.fees[0]?.status).toBe('retained');
  });

  it('une milliseconde avant : rien n’expire', () => {
    const error = thrown(() =>
      expireQuote({
        quote: sent,
        requestStatus: 'quote_sent',
        fees: [fee],
        now: at('2026-12-07T11:59:59.999Z'),
      }),
    );
    expect(error.details).toEqual({ from: 'sent', to: 'expired' });
  });
});

describe('nouvelle visite (R-VI-07)', () => {
  const sent = sendQuote({
    quote: composeQuote(composition()),
    requestStatus: 'visit_done',
    previous: null,
    ...sendSettings,
    now: NOW,
  }).quote;

  it('depuis « devis envoyé » : devis retiré avec son motif, demande à replanifier', () => {
    const later = at('2026-11-23T12:00:00Z');
    const result = requestNewVisit({
      request: { status: 'quote_sent', sentQuoteValidUntil: sent.validUntil },
      sentQuote: sent,
      reason: 'Pièces oubliées',
      staffId: 'sup-1',
      now: later,
    });
    expect(result.requestStatus).toBe('visit_to_schedule');
    expect(result.withdrawn).toMatchObject({
      status: 'withdrawn',
      withdrawnAt: later,
      withdrawnBy: 'sup-1',
      withdrawalReason: 'Pièces oubliées',
    });
  });

  it('depuis « visite faite » : rien à retirer', () => {
    const result = requestNewVisit({
      request: { status: 'visit_done' },
      sentQuote: null,
      reason: 'Mesures douteuses',
      staffId: 'sup-1',
      now: NOW,
    });
    expect(result).toEqual({ requestStatus: 'visit_to_schedule', withdrawn: null });
  });

  it('motif obligatoire ; impossible sur un devis périmé ou avant la visite', () => {
    expect(
      thrown(() =>
        requestNewVisit({
          request: { status: 'visit_done' },
          sentQuote: null,
          reason: '',
          staffId: 'sup-1',
          now: NOW,
        }),
      ).code,
    ).toBe('CLEANING_REASON_REQUIRED');
    const expired = { status: 'quote_sent' as const, sentQuoteValidUntil: sent.validUntil };
    expect(
      thrown(() =>
        requestNewVisit({
          request: expired,
          sentQuote: sent,
          reason: 'x',
          staffId: 'sup-1',
          now: at('2026-12-07T12:00:00Z'),
        }),
      ).details,
    ).toEqual({
      from: 'expired',
      to: 'visit_to_schedule',
    });
    expect(
      thrown(() =>
        requestNewVisit({
          request: { status: 'visit_scheduled' },
          sentQuote: null,
          reason: 'x',
          staffId: 'sup-1',
          now: NOW,
        }),
      ).code,
    ).toBe('CLEANING_INVALID_TRANSITION');
  });

  it('un devis retiré ne peut plus répondre', () => {
    const withdrawn: Quote = { ...sent, status: 'withdrawn' };
    expect(effectiveQuoteStatus(withdrawn, NOW)).toBe('withdrawn');
  });
});

describe('demande annulée ou refusée : devis envoyé retiré (décision du responsable)', () => {
  const sent = sendQuote({
    quote: composeQuote(composition()),
    requestStatus: 'visit_done',
    previous: null,
    ...sendSettings,
    now: NOW,
  }).quote;
  const later = at('2026-11-23T12:00:00Z');

  it('le devis encore valable passe « retiré », avec l’auteur et la cause', () => {
    expect(withdrawOnRequestClosed(sent, 'cancelled', 'client-1', later)).toMatchObject({
      status: 'withdrawn',
      withdrawnAt: later,
      withdrawnBy: 'client-1',
      withdrawalReason: 'request_cancelled',
    });
    expect(withdrawOnRequestClosed(sent, 'rejected', 'sup-1', later)?.withdrawalReason).toBe(
      'request_rejected',
    );
  });

  it('rien à retirer : aucun devis, brouillon, ou devis déjà périmé', () => {
    expect(withdrawOnRequestClosed(null, 'cancelled', 'client-1', later)).toBeNull();
    expect(withdrawOnRequestClosed(composeQuote(composition()), 'cancelled', 'client-1', later)).toBeNull();
    expect(withdrawOnRequestClosed(sent, 'rejected', 'sup-1', sent.validUntil as Date)).toBeNull();
  });
});
