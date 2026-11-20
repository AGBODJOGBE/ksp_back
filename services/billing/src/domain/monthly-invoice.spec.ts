import { invoiceYear } from './invoice';
import {
  beninDate,
  type BillableSession,
  billingMonth,
  DEFAULT_REMINDER_OFFSETS,
  draftMonthlyInvoice,
  dueReminder,
  isPastDueV2,
  lastClosedMonth,
  missedLineKind,
  monthlyInvoiceLines,
  monthOf,
  overdueFrom,
  reminderAt,
  reminderOffsetsProblems,
  sessionsToInvoice,
} from './monthly-invoice';

const at = (iso: string) => new Date(iso);
const ORG = '0192f1c4-0000-7000-8000-00000000000a';
const HEADER = { legalName: 'SARL Bénin Propre', address: 'Cotonou', ifu: '1234567890123', rccm: null };

function session(overrides: Partial<BillableSession> = {}): BillableSession {
  return {
    sessionId: 's1',
    organizationId: ORG,
    customerId: 'c1',
    programId: 'p1',
    programNumber: 'PN-000057',
    placeId: 'l1',
    rank: 1,
    sessionsCount: 15,
    kind: 'session',
    occurredAt: at('2026-11-12T10:00:00Z'),
    amountDue: 20_000,
    visitFeeDeduction: 0,
    invoiceId: null,
    ...overrides,
  };
}

describe('Mois facturé (R-PE-01, RV-92 : mois civil à Porto-Novo)', () => {
  it('le mois commence et finit à minuit, heure du Bénin', () => {
    expect(billingMonth(2026, 11)).toEqual({
      year: 2026,
      month: 11,
      start: at('2026-10-31T23:00:00Z'),
      end: at('2026-11-30T23:00:00Z'),
    });
  });

  it('une séance réalisée le 30 novembre à 23:30 UTC appartient au mois de décembre', () => {
    expect(monthOf(at('2026-11-30T23:30:00Z'))).toMatchObject({ year: 2026, month: 12 });
    expect(monthOf(at('2026-11-30T22:59:59.999Z'))).toMatchObject({ year: 2026, month: 11 });
  });

  it('le passage du 1er janvier facture décembre, avec l’année de décembre', () => {
    const december = lastClosedMonth(at('2026-12-31T23:00:00Z'));
    expect(december).toMatchObject({ year: 2026, month: 12 });
    expect(invoiceYear({ periodStart: december.start })).toBe(2026);
    expect(lastClosedMonth(at('2026-12-31T22:59:59Z'))).toMatchObject({ year: 2026, month: 11 });
  });

  it('date de la séance au Bénin', () => {
    expect(beninDate(at('2026-11-30T23:30:00Z'))).toBe('2026-12-01');
  });
});

describe('Lignes de la facture mensuelle (R-PE-01, R-FV-05)', () => {
  it('groupées par programme, puis par lieu, puis par date et rang', () => {
    const lines = monthlyInvoiceLines([
      session({ sessionId: 'b', programNumber: 'PN-000058', occurredAt: at('2026-11-02T10:00:00Z') }),
      session({ sessionId: 'c', placeId: 'l2', occurredAt: at('2026-11-01T10:00:00Z') }),
      session({ sessionId: 'a2', rank: 3, occurredAt: at('2026-11-20T10:00:00Z') }),
      session({ sessionId: 'a1', rank: 2, occurredAt: at('2026-11-20T10:00:00Z') }),
    ]);
    expect(lines.map((line) => line.sourceObjectId)).toEqual(['a1', 'a2', 'c', 'b']);
  });

  it('une ligne par séance avec sa date ; la déduction des frais de visite en ligne négative', () => {
    const lines = monthlyInvoiceLines([session({ amountDue: 15_000, visitFeeDeduction: 5_000 })]);
    expect(lines).toEqual([
      {
        label: 'Séance 1/15 du 12/11/2026 — PN-000057',
        quantity: 1,
        unitPrice: 20_000,
        amount: 20_000,
        kind: 'session',
        serviceDate: '2026-11-12',
        programNumber: 'PN-000057',
        sourceObjectId: 's1',
      },
      expect.objectContaining({ kind: 'visit_fee_deduction', amount: -5_000, unitPrice: -5_000 }),
    ]);
  });

  it('séance manquée et annulation tardive : libellés distincts, montant dû porté par l’événement', () => {
    expect(missedLineKind('customer_absent')).toBe('missed_session');
    expect(missedLineKind('access_impossible')).toBe('missed_session');
    expect(missedLineKind('late_cancellation')).toBe('late_cancellation');
    const [missed, late] = monthlyInvoiceLines([
      session({ kind: 'missed_session', amountDue: 10_000 }),
      session({ sessionId: 's2', rank: 2, kind: 'late_cancellation', amountDue: 10_000 }),
    ]);
    expect(missed!.label).toMatch(/^Séance manquée 1\/15/);
    expect(late!.label).toMatch(/^Annulation tardive, séance 2\/15/);
  });
});

describe('Séances d’une facture (R-PE-07 : une séance oubliée part sur la facture suivante)', () => {
  const november = billingMonth(2026, 11);

  it('prend les séances non facturées réalisées avant la fin du mois, y compris un mois antérieur', () => {
    const late = session({ sessionId: 'oct', occurredAt: at('2026-10-30T10:00:00Z') });
    const billed = session({ sessionId: 'billed', invoiceId: 'inv-oct' });
    const december = session({ sessionId: 'dec', occurredAt: at('2026-11-30T23:00:00Z') });
    const ids = sessionsToInvoice([late, billed, december, session()], november).map((s) => s.sessionId);
    expect(ids).toEqual(['oct', 's1']);
  });
});

describe('Brouillon de facture mensuelle (R-PE-02, R-PE-03)', () => {
  const base = {
    id: 'inv1',
    organizationId: ORG,
    month: billingMonth(2026, 11),
    organization: HEADER,
    now: at('2026-11-30T23:00:00Z'),
    paymentTermDays: 10,
  };

  it('en-tête figé, échéance à 10 jours, sans contrat, kind monthly', () => {
    const draft = draftMonthlyInvoice({
      ...base,
      sessions: [session({ customerId: 'c2', rank: 2 }), session({ sessionId: 's0', customerId: 'c1' })],
    });
    expect(draft).toMatchObject({
      status: 'pending_payment',
      contractId: null,
      periodIndex: null,
      customerId: 'c1',
      organizationId: ORG,
      total: 40_000,
      kind: 'monthly',
      organization: HEADER,
      periodStart: at('2026-10-31T23:00:00Z'),
      periodEnd: at('2026-11-30T23:00:00Z'),
      dueAt: at('2026-12-10T23:00:00Z'),
      paidAt: null,
      settledBy: null,
    });
  });

  it('total nul (frais de visite qui couvrent tout) : émise payée', () => {
    const draft = draftMonthlyInvoice({
      ...base,
      sessions: [session({ amountDue: 0, visitFeeDeduction: 20_000 })],
    });
    expect(draft).toMatchObject({ total: 0, status: 'paid', paidAt: base.now, settledBy: 'payment' });
  });

  it('jamais de facture sans séance', () => {
    expect(() => draftMonthlyInvoice({ ...base, sessions: [] })).toThrow('Facture mensuelle sans séance.');
  });
});

describe('Impayée le lendemain de l’échéance (R-PE-06)', () => {
  const invoice = {
    status: 'pending_payment' as const,
    dueAt: at('2026-12-10T23:00:00Z'),
    total: 40_000,
    payments: [],
    creditedAmount: 0,
  };

  it('le jour de l’échéance (11 décembre au Bénin) n’est pas encore impayé', () => {
    expect(overdueFrom(invoice.dueAt)).toEqual(at('2026-12-11T23:00:00Z'));
    expect(isPastDueV2(invoice, at('2026-12-11T22:59:59.999Z'))).toBe(false);
    expect(isPastDueV2(invoice, at('2026-12-11T23:00:00Z'))).toBe(true);
  });

  it('une facture soldée par avoir, payée ou déjà impayée ne repasse pas', () => {
    const later = at('2026-12-20T00:00:00Z');
    expect(isPastDueV2({ ...invoice, creditedAmount: 40_000 }, later)).toBe(false);
    expect(isPastDueV2({ ...invoice, status: 'overdue' }, later)).toBe(false);
    expect(isPastDueV2({ ...invoice, status: 'paid' }, later)).toBe(false);
  });
});

describe('Relances (R-PE-05)', () => {
  const invoice = {
    status: 'pending_payment' as const,
    dueAt: at('2026-12-10T23:00:00Z'),
    total: 40_000,
    payments: [],
    creditedAmount: 0,
  };
  const none = new Set<number>();

  it('3 jours avant, le jour même, 3 et 7 jours après l’échéance', () => {
    expect(DEFAULT_REMINDER_OFFSETS).toEqual([-3, 0, 3, 7]);
    expect(reminderAt(invoice.dueAt, -3)).toEqual(at('2026-12-07T23:00:00Z'));
    expect(
      dueReminder(invoice, DEFAULT_REMINDER_OFFSETS, none, at('2026-12-07T22:59:00Z')).offset,
    ).toBeNull();
    expect(dueReminder(invoice, DEFAULT_REMINDER_OFFSETS, none, at('2026-12-07T23:00:00Z'))).toEqual({
      offset: -3,
      skipped: [],
    });
    expect(dueReminder(invoice, DEFAULT_REMINDER_OFFSETS, new Set([-3]), at('2026-12-10T23:00:00Z'))).toEqual(
      { offset: 0, skipped: [] },
    );
    const overdue = { ...invoice, status: 'overdue' as const };
    expect(
      dueReminder(overdue, DEFAULT_REMINDER_OFFSETS, new Set([-3, 0]), at('2026-12-18T00:00:00Z')),
    ).toEqual({ offset: 7, skipped: [3] });
  });

  it('une relance déjà traitée ne repart pas ; rien sur une facture soldée', () => {
    const sent = new Set([-3, 0, 3, 7]);
    expect(
      dueReminder(invoice, DEFAULT_REMINDER_OFFSETS, sent, at('2026-12-30T00:00:00Z')).offset,
    ).toBeNull();
    const paid = { ...invoice, status: 'paid' as const };
    expect(dueReminder(paid, DEFAULT_REMINDER_OFFSETS, none, at('2026-12-30T00:00:00Z'))).toEqual({
      offset: null,
      skipped: [],
    });
    const credited = { ...invoice, creditedAmount: 40_000 };
    expect(
      dueReminder(credited, DEFAULT_REMINDER_OFFSETS, none, at('2026-12-30T00:00:00Z')).offset,
    ).toBeNull();
  });

  it('décalages valides : entiers de −30 à 60, sans doublon', () => {
    expect(reminderOffsetsProblems([-3, 0, 3, 7])).toEqual([]);
    expect(reminderOffsetsProblems([0, 0])).toEqual(['reminders']);
    expect(reminderOffsetsProblems([61])).toEqual(['reminders']);
    expect(reminderOffsetsProblems([-31])).toEqual(['reminders']);
    expect(reminderOffsetsProblems([1.5])).toEqual(['reminders']);
  });
});
