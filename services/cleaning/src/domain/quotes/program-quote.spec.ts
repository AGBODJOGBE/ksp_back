import { DomainRuleError } from '../requests/errors';
import {
  acceptAmendmentQuote,
  acceptProgramQuote,
  composeAmendmentQuote,
  composeProgramQuote,
  declineProgramQuote,
  expireProgramQuote,
  type ProgramQuoteComposition,
  sendAmendmentQuote,
  sendProgramQuote,
} from './program-quote';
import { type Quote } from './quote';

const at = (iso: string) => new Date(iso);
const NOW = at('2026-12-15T10:00:00Z');
const STARTS = [at('2026-12-29T08:00:00Z'), at('2027-01-05T08:00:00Z'), at('2027-01-12T08:00:00Z')];

function thrown(fn: () => unknown): DomainRuleError {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainRuleError) return error;
    throw error;
  }
  throw new Error('aucune erreur levée');
}

function composition(patch: Partial<ProgramQuoteComposition> = {}): ProgramQuoteComposition {
  return {
    id: 'quote-2',
    requestId: 'req-1',
    version: 2,
    retainedRevision: 1,
    lines: [
      {
        offerId: 'o',
        cleaningTypeId: 'floor',
        name: 'Sol',
        quantity: 1,
        unitPrice: 3_500,
        amount: 3_500,
        kind: 'offer',
      },
    ],
    basePrice: 3_500,
    adjustments: [],
    sessionStarts: STARTS,
    teamSize: 1,
    durationMinutes: 120,
    paymentTerms: 'per_session',
    termsVersion: 'cg-2026-11',
    discountApprovalThresholdPercent: 20,
    firstSessionLeadHours: 48,
    createdBy: 'system',
    now: NOW,
    ...patch,
  };
}

const send = (quote: Quote, pending: Quote | null = null, now = NOW) =>
  sendProgramQuote({ quote, pending, validityDays: 15, firstSessionLeadHours: 48, now });
const sent = () => send(composeProgramQuote(composition())).quote;

describe('devis rattaché à un programme (R-PG-06, R-PG-07)', () => {
  it('composition : brouillon au prix du jour, sans frais de visite à déduire', () => {
    const draft = composeProgramQuote(composition());
    expect(draft).toMatchObject({
      status: 'draft',
      sessionPrice: 3_500,
      sessionsCount: 3,
      total: 10_500,
      deductibleVisitFee: 0,
      visitFeeDeduction: 0,
    });
  });

  it('composition : première séance trop proche ou prix nul refusés comme pour un devis initial', () => {
    const close = composition({ sessionStarts: [at('2026-12-16T08:00:00Z')] });
    expect(thrown(() => composeProgramQuote(close)).code).toBe('CLEANING_LEAD_TIME_TOO_SHORT');
    const free = composition({
      adjustments: [{ kind: 'discount', fixedAmount: 3_500, reason: 'Geste commercial' }],
    });
    expect(thrown(() => composeProgramQuote(free)).code).toBe('CLEANING_PRICE_NOT_POSITIVE');
  });

  it('envoi : statut « envoyé », validité des réglages', () => {
    const result = send(composeProgramQuote(composition()));
    expect(result.expired).toBeNull();
    expect(result.quote).toMatchObject({
      status: 'sent',
      sentAt: NOW,
      validUntil: at('2026-12-30T10:00:00Z'),
    });
  });

  it('envoi : un devis encore valable sur la demande bloque ; un devis périmé passe « expiré »', () => {
    const pending = sent();
    const next = composeProgramQuote(composition({ id: 'quote-3', version: 3 }));
    const blocked = thrown(() => send(next, pending));
    expect(blocked.code).toBe('CLEANING_INVALID_TRANSITION');
    expect(blocked.details).toEqual({ from: 'sent', to: 'sent' });

    const later = at('2026-12-31T10:00:00Z');
    const starts = [at('2027-01-05T08:00:00Z'), at('2027-01-12T08:00:00Z')];
    const draft = composeProgramQuote(
      composition({ id: 'quote-3', version: 3, sessionStarts: starts, now: later }),
    );
    const result = send(draft, pending, later);
    expect(result.expired).toMatchObject({ id: 'quote-2', status: 'expired' });
    expect(result.quote.status).toBe('sent');
  });

  it('acceptation : programme confirmé, séances au prix du devis, aucune déduction', () => {
    const accepted = acceptProgramQuote({
      quote: sent(),
      organization: null,
      firstSessionLeadHours: 48,
      userId: 'client-1',
      now: at('2026-12-16T10:00:00Z'),
    });
    expect(accepted.quote).toMatchObject({ status: 'accepted', respondedBy: 'client-1' });
    expect(accepted.program).toMatchObject({ status: 'confirmed', total: 10_500, visitFeeDeduction: 0 });
    expect(accepted.program.sessions.map((session) => [session.rank, session.price])).toEqual([
      [1, 3_500],
      [2, 3_500],
      [3, 3_500],
    ]);
  });

  it('acceptation : devis périmé refusé ; organisation : administrateur seulement', () => {
    const late = {
      organization: null,
      firstSessionLeadHours: 48,
      userId: 'client-1',
      now: at('2026-12-31T10:00:00Z'),
    };
    expect(thrown(() => acceptProgramQuote({ quote: sent(), ...late })).code).toBe('CLEANING_QUOTE_EXPIRED');
    const member = {
      organization: {
        role: 'org_member' as const,
        suspended: false,
        unpaidInvoices: 0,
        unpaidInvoicesSuspension: 2,
      },
      firstSessionLeadHours: 48,
      userId: 'client-1',
      now: at('2026-12-16T10:00:00Z'),
    };
    expect(thrown(() => acceptProgramQuote({ quote: sent(), ...member })).code).toBe('AUTH_FORBIDDEN');
  });

  it('refus : seul le devis change', () => {
    const declined = declineProgramQuote({
      quote: sent(),
      role: null,
      reasonCode: 'price',
      userId: 'client-1',
      now: at('2026-12-16T10:00:00Z'),
    });
    expect(declined).toMatchObject({
      status: 'declined',
      declineReasonCode: 'price',
      respondedBy: 'client-1',
    });
  });

  it('expiration : à la fin de la validité seulement', () => {
    expect(thrown(() => expireProgramQuote(sent(), at('2026-12-20T10:00:00Z'))).code).toBe(
      'CLEANING_INVALID_TRANSITION',
    );
    expect(expireProgramQuote(sent(), at('2026-12-31T10:00:00Z')).status).toBe('expired');
  });
});

describe('devis d’avenant (R-PG-06)', () => {
  const tomorrow = at('2026-12-16T08:00:00Z');
  const remaining = [tomorrow, at('2026-12-22T08:00:00Z')];
  const added = [at('2026-12-29T08:00:00Z'), at('2027-01-05T08:00:00Z')];
  const { sessionStarts: _starts, ...base } = composition();
  const draft = (patch: { remainingStarts?: Date[]; addedStarts?: Date[] } = {}) =>
    composeAmendmentQuote({ ...base, remainingStarts: remaining, addedStarts: added, ...patch });
  const sendDraft = (quote: Quote, pending: Quote | null = null, replaces = false) =>
    sendAmendmentQuote({
      quote,
      addedStarts: added,
      pending,
      replaces,
      validityDays: 15,
      firstSessionLeadHours: 48,
      now: NOW,
    });

  it('composition : séances restantes et ajoutées au nouveau prix ; une séance du lendemain ne bloque pas', () => {
    expect(draft()).toMatchObject({
      status: 'draft',
      sessionPrice: 3_500,
      sessionsCount: 4,
      total: 14_000,
      visitFeeDeduction: 0,
      sessionStarts: [...remaining, ...added],
    });
  });

  it('composition : le délai minimum vaut pour les séances ajoutées ; aucune séance : refusé', () => {
    expect(thrown(() => draft({ addedStarts: [tomorrow] })).code).toBe('CLEANING_LEAD_TIME_TOO_SHORT');
    expect(thrown(() => draft({ remainingStarts: [], addedStarts: [] })).code).toBe(
      'CLEANING_SCHEDULE_EMPTY',
    );
    // Un type ajouté sans séance : les séances restantes suffisent.
    expect(draft({ addedStarts: [] })).toMatchObject({ sessionsCount: 2, total: 7_000 });
  });

  it('envoi : dates et total gardés ; la révision remplace le devis d’avenant envoyé', () => {
    const first = sendDraft(draft());
    expect(first.quote).toMatchObject({ status: 'sent', sessionsCount: 4, total: 14_000 });
    expect(first.quote.sessionStarts).toEqual([...remaining, ...added]);
    const revision = composeAmendmentQuote({
      ...base,
      id: 'quote-3',
      version: 3,
      remainingStarts: remaining,
      addedStarts: added,
    });
    expect(thrown(() => sendDraft(revision, first.quote)).code).toBe('CLEANING_INVALID_TRANSITION');
    const replaced = sendDraft(revision, first.quote, true);
    expect(replaced.superseded).toMatchObject({ id: 'quote-2', status: 'superseded' });
    expect(replaced.expired).toBeNull();
  });

  it('acceptation : devis accepté, délai contrôlé sur les séances ajoutées seulement', () => {
    const sentQuote = sendDraft(draft()).quote;
    const input = { quote: sentQuote, organization: null, firstSessionLeadHours: 48, userId: 'client-1' };
    const accepted = acceptAmendmentQuote({ ...input, addedStarts: added, now: at('2026-12-16T10:00:00Z') });
    expect(accepted).toMatchObject({ status: 'accepted', respondedBy: 'client-1', sessionsCount: 4 });
    // La veille d'une séance ajoutée : trop tard pour elle.
    expect(
      thrown(() => acceptAmendmentQuote({ ...input, addedStarts: added, now: at('2026-12-28T10:00:00Z') }))
        .code,
    ).toBe('CLEANING_LEAD_TIME_TOO_SHORT');
    expect(
      thrown(() => acceptAmendmentQuote({ ...input, addedStarts: added, now: at('2026-12-31T10:00:00Z') }))
        .code,
    ).toBe('CLEANING_QUOTE_EXPIRED');
  });
});
