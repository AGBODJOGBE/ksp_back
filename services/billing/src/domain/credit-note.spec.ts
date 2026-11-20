import {
  cancelInvoice,
  creditableAmount,
  creditNoteProblem,
  formatCreditNoteNumber,
  splitCreditNote,
  withCreditNote,
} from './credit-note';
import { balance, type Invoice } from './invoice';

const at = (iso: string) => new Date(iso);
const line = (amount: number) => ({
  label: 'Séance 3/15 non réalisée',
  quantity: 1,
  unitPrice: amount,
  amount,
});

function monthly(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv1',
    number: 'FAC-2026-000042',
    status: 'pending_payment',
    contractId: null,
    customerId: 'c1',
    organizationId: 'o1',
    source: 'cleaning',
    periodIndex: null,
    periodStart: at('2026-10-31T23:00:00Z'),
    periodEnd: at('2026-11-30T23:00:00Z'),
    lines: [],
    total: 40_000,
    issuedAt: at('2026-11-30T23:00:00Z'),
    dueAt: at('2026-12-10T23:00:00Z'),
    paidAt: null,
    payments: [],
    organization: null,
    version: 0,
    kind: 'monthly',
    settledBy: null,
    creditedAmount: 0,
    creditNotesTotal: 0,
    ...overrides,
  };
}

const payment = (amount: number) => ({
  id: 'p1',
  amount,
  method: 'wallet' as const,
  reference: 'tx1',
  recordedBy: 'u1',
  recordedAt: at('2026-12-05T10:00:00Z'),
});

describe('Avoirs (R-PE-07)', () => {
  it('numéro AV-<année>-<6 chiffres>', () => {
    expect(formatCreditNoteNumber(2026, 3)).toBe('AV-2026-000003');
  });

  it('lignes positives, 1 à 50 ; motif obligatoire, 500 caractères au plus', () => {
    expect(creditNoteProblem([line(5_000)], 'Séance non réalisée')).toBeNull();
    expect(creditNoteProblem([], 'motif')).toBe('lines');
    expect(
      creditNoteProblem(
        Array.from({ length: 51 }, () => line(1)),
        'motif',
      ),
    ).toBe('lines');
    expect(creditNoteProblem([line(0)], 'motif')).toBe('lines');
    expect(creditNoteProblem([{ ...line(5_000), unitPrice: -5_000 }], 'motif')).toBe('lines');
    expect(creditNoteProblem([{ ...line(5_000), quantity: 0 }], 'motif')).toBe('lines');
    expect(creditNoteProblem([{ ...line(5_000), label: ' ' }], 'motif')).toBe('lines');
    expect(creditNoteProblem([{ ...line(5_000), amount: 1.5 }], 'motif')).toBe('lines');
    expect(creditNoteProblem([line(5_000)], '  ')).toBe('reason');
    expect(creditNoteProblem([line(5_000)], 'x'.repeat(501))).toBe('reason');
  });

  it('imputé d’abord sur le reste dû', () => {
    expect(splitCreditNote(monthly(), 10_000)).toEqual({ appliedToBalance: 10_000, creditedToWallet: 0 });
  });

  it('facture déjà payée en partie : le reste va au portefeuille', () => {
    const invoice = monthly({ payments: [payment(35_000)] });
    expect(splitCreditNote(invoice, 10_000)).toEqual({ appliedToBalance: 5_000, creditedToWallet: 5_000 });
  });

  it('jamais au-delà du total de la facture, avoirs précédents compris', () => {
    const invoice = monthly({ creditNotesTotal: 30_000, creditedAmount: 30_000 });
    expect(creditableAmount(invoice)).toBe(10_000);
    expect(splitCreditNote(invoice, 10_001)).toEqual({ code: 'exceeds_invoice', maximum: 10_000 });
    expect(splitCreditNote(monthly({ status: 'cancelled' }), 1)).toEqual({
      code: 'invalid_transition',
      status: 'cancelled',
    });
  });

  it('un avoir qui ramène le reste dû à 0 solde la facture (settledBy credit_note)', () => {
    const invoice = monthly({ status: 'overdue' });
    const { invoice: next, settled } = withCreditNote(
      invoice,
      { appliedToBalance: 40_000, creditedToWallet: 0 },
      at('2026-12-20T10:00:00Z'),
    );
    expect(settled).toBe(true);
    expect(next).toMatchObject({
      status: 'paid',
      settledBy: 'credit_note',
      paidAt: at('2026-12-20T10:00:00Z'),
      creditedAmount: 40_000,
      creditNotesTotal: 40_000,
    });
    expect(balance(next)).toBe(0);
  });

  it('avoir partiel : la facture reste ouverte ; facture payée : rien ne change d’état', () => {
    const partial = withCreditNote(
      monthly(),
      { appliedToBalance: 10_000, creditedToWallet: 0 },
      at('2026-12-01'),
    );
    expect(partial.settled).toBe(false);
    expect(balance(partial.invoice)).toBe(30_000);
    const paid = monthly({ status: 'paid', payments: [payment(40_000)], settledBy: 'payment' });
    const after = withCreditNote(paid, { appliedToBalance: 0, creditedToWallet: 5_000 }, at('2026-12-01'));
    expect(after.settled).toBe(false);
    expect(after.invoice).toMatchObject({ status: 'paid', settledBy: 'payment', creditNotesTotal: 5_000 });
  });

  it('facture v1 sans champs d’avoir : comptés à 0', () => {
    const legacy = monthly({ kind: null });
    delete legacy.creditedAmount;
    delete legacy.creditNotesTotal;
    expect(creditableAmount(legacy)).toBe(40_000);
    expect(
      withCreditNote(legacy, { appliedToBalance: 1_000, creditedToWallet: 0 }, at('2026-12-01')).invoice,
    ).toMatchObject({ creditedAmount: 1_000, creditNotesTotal: 1_000 });
  });
});

describe('Annulation (RV-87 : settledBy cancellation)', () => {
  it('une facture v2 ouverte sans paiement est annulée', () => {
    const result = cancelInvoice(monthly({ status: 'overdue' }));
    expect(result).toEqual({
      invoice: expect.objectContaining({ status: 'cancelled', settledBy: 'cancellation', paidAt: null }),
    });
  });

  it('refusée : facture v1, soldée, annulée ou déjà payée en partie', () => {
    expect(cancelInvoice(monthly({ kind: null }))).toEqual({ refusal: 'invalid_transition' });
    expect(cancelInvoice(monthly({ status: 'paid' }))).toEqual({ refusal: 'invalid_transition' });
    expect(cancelInvoice(monthly({ status: 'cancelled' }))).toEqual({ refusal: 'invalid_transition' });
    expect(cancelInvoice(monthly({ payments: [payment(1_000)] }))).toEqual({ refusal: 'partially_paid' });
  });
});
