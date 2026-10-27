import {
  addMonths,
  applyResumption,
  applySuspension,
  beninDay,
  beninMidnight,
  type BillingContract,
  contractPeriods,
  duePeriods,
} from './contract';
import {
  canTransitionInvoice,
  periodLines,
  dueDate,
  formatInvoiceNumber,
  type Invoice,
  isOverdue,
  paymentRefusal,
  withPayment,
} from './invoice';
import { billingSettingsProblems, DEFAULT_BILLING_SETTINGS } from './settings';

const at = (iso: string) => new Date(iso);

function contract(overrides: Partial<BillingContract> = {}): BillingContract {
  return {
    id: 'm1',
    source: 'cleaning',
    customerId: 'c1',
    organizationId: 'o1',
    total: 100_000,
    durationMonths: 3,
    startsAt: at('2026-11-05T08:00:00Z'),
    terminatedAt: null,
    suspendedSince: null,
    suspensions: [],
    lastResumedAt: null,
    createdAt: at('2026-10-23T08:00:00Z'),
    ...overrides,
  };
}

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'i1',
    number: 'FAC-2026-000001',
    status: 'pending_payment',
    contractId: 'm1',
    customerId: 'c1',
    organizationId: 'o1',
    source: 'cleaning',
    periodIndex: 1,
    periodStart: at('2026-11-05T08:00:00Z'),
    periodEnd: at('2026-12-05T08:00:00Z'),
    lines: [],
    total: 33_333,
    issuedAt: at('2026-12-05T08:00:00Z'),
    dueAt: at('2026-12-15T08:00:00Z'),
    paidAt: null,
    payments: [],
    organization: null,
    version: 0,
    ...overrides,
  };
}

describe('mois civils et prorata', () => {
  const amounts = (c: BillingContract) => contractPeriods(c).map((p) => p.amount);

  it('ajoute des mois en UTC, en ramenant au dernier jour du mois', () => {
    expect(addMonths(at('2026-01-31T10:00:00Z'), 1)).toEqual(at('2026-02-28T10:00:00Z'));
    expect(addMonths(at('2026-11-05T08:00:00Z'), 2)).toEqual(at('2027-01-05T08:00:00Z'));
  });

  it('jours à l’heure du Bénin (UTC+1) : 23:30 UTC est déjà le lendemain', () => {
    expect(beninDay(at('2026-11-30T23:30:00Z'))).toBe(beninDay(at('2026-12-01T12:00:00Z')));
    expect(beninMidnight(beninDay(at('2026-12-01T12:00:00Z')))).toEqual(at('2026-11-30T23:00:00Z'));
  });

  it('premier et dernier mois partiels au prorata ; le dernier absorbe l’écart, total exact', () => {
    const c = contract({ total: 300_000 });
    const periods = contractPeriods(c);
    expect(periods.map((p) => [p.year, p.month, p.contractDays, p.daysInMonth])).toEqual([
      [2026, 11, 26, 30],
      [2026, 12, 31, 31],
      [2027, 1, 31, 31],
      [2027, 2, 4, 28],
    ]);
    expect(amounts(c)).toEqual([86_667, 100_000, 100_000, 13_333]);
    expect(amounts(c).reduce((sum, amount) => sum + amount, 0)).toBe(300_000);
    // Émission le 1er du mois suivant à 00:00, heure du Bénin.
    expect(periods[0]!.issueAt).toEqual(at('2026-11-30T23:00:00Z'));
    expect(periods[0]!.start).toEqual(at('2026-11-04T23:00:00Z'));
  });

  it('contrat commencé le 1er : mois entiers, montant mensuel', () => {
    expect(amounts(contract({ total: 300_000, startsAt: at('2026-11-30T23:00:00Z') }))).toEqual([
      100_000, 100_000, 100_000,
    ]);
  });

  it('jours de suspension déduits au prorata (suspension passée ou en cours)', () => {
    const past = contract({
      total: 300_000,
      suspensions: [{ from: at('2026-12-10T10:00:00Z'), to: at('2026-12-20T10:00:00Z') }],
    });
    expect(contractPeriods(past)[1]).toMatchObject({ suspendedDays: 10, amount: 67_742 });
    const ongoing = contract({ total: 300_000, suspendedSince: at('2027-01-20T00:00:00Z') });
    expect(contractPeriods(ongoing)[2]).toMatchObject({ suspendedDays: 12, amount: 61_290 });
    // Dernier mois entièrement suspendu : rien à facturer.
    expect(contractPeriods(ongoing)[3]!.amount).toBe(0);
    expect(duePeriods(ongoing, new Set([1, 2, 3]), at('2027-03-01T00:00:00Z'))).toEqual([]);
  });

  it('annulation : prorata jusqu’au jour de l’annulation, sans absorption', () => {
    const c = contract({ total: 300_000, terminatedAt: at('2027-01-10T12:00:00Z') });
    expect(amounts(c)).toEqual([86_667, 100_000, 29_032]);
  });

  it('facturation à la fin du mois civil seulement', () => {
    const c = contract({ total: 300_000 });
    expect(duePeriods(c, new Set(), at('2026-11-30T22:59:59Z'))).toEqual([]);
    expect(duePeriods(c, new Set(), at('2026-11-30T23:00:00Z')).map((p) => p.index)).toEqual([1]);
    expect(duePeriods(c, new Set([1]), at('2027-02-10T00:00:00Z')).map((p) => p.index)).toEqual([2, 3]);
  });

  it('événements dans le désordre : une suspension reçue après la reprise est replacée dans l’historique', () => {
    const resumedFirst = applyResumption(contract(), at('2026-12-10T00:00:00Z'));
    const late = applySuspension(resumedFirst, at('2026-12-01T00:00:00Z'));
    expect(late.suspendedSince).toBeNull();
    expect(late.suspensions).toEqual([{ from: at('2026-12-01T00:00:00Z'), to: at('2026-12-10T00:00:00Z') }]);
    const suspended = applySuspension(contract(), at('2026-12-01T00:00:00Z'));
    expect(applyResumption(suspended, at('2026-12-10T00:00:00Z')).suspensions).toHaveLength(1);
  });
});

describe('factures', () => {
  it('échéance = émission + délai de règlement (10 jours par défaut)', () => {
    expect(dueDate(at('2026-12-05T08:00:00Z'), DEFAULT_BILLING_SETTINGS.paymentTermDays)).toEqual(
      at('2026-12-15T08:00:00Z'),
    );
  });

  it('« en attente » pendant le délai, « impayée » à l’échéance', () => {
    expect(isOverdue(invoice(), at('2026-12-15T07:59:59Z'))).toBe(false);
    expect(isOverdue(invoice(), at('2026-12-15T08:00:00Z'))).toBe(true);
    expect(isOverdue(invoice({ status: 'paid' }), at('2027-01-01T00:00:00Z'))).toBe(false);
  });

  it('transitions autorisées seulement', () => {
    expect(canTransitionInvoice('pending_payment', 'overdue')).toBe(true);
    expect(canTransitionInvoice('overdue', 'paid')).toBe(true);
    expect(canTransitionInvoice('paid', 'overdue')).toBe(false);
    expect(canTransitionInvoice('cancelled', 'paid')).toBe(false);
  });

  it('ligne : mois civil, jours facturés, suspension déduite', () => {
    const period = contractPeriods(
      contract({
        total: 300_000,
        suspensions: [{ from: at('2026-12-10T10:00:00Z'), to: at('2026-12-20T10:00:00Z') }],
      }),
    )[1]!;
    expect(periodLines(period)).toEqual([
      {
        label: 'Prestation de nettoyage — décembre 2026 : 21 jours sur 31, 10 jours de suspension déduits',
        quantity: 1,
        unitPrice: 67_742,
        amount: 67_742,
      },
    ]);
  });

  it('numéro continu par année sur 6 chiffres', () => {
    expect(formatInvoiceNumber(2026, 42)).toBe('FAC-2026-000042');
  });

  it('paiement manuel : partiel accepté, jamais au-delà du reste dû', () => {
    const base = invoice();
    expect(paymentRefusal(base, 0, 'cash')).toBe('amount_invalid');
    expect(paymentRefusal(base, 10.5, 'cash')).toBe('amount_invalid');
    expect(paymentRefusal(base, 1000, 'cheque')).toBe('method_not_allowed');
    expect(paymentRefusal(base, 33_334, 'cash')).toBe('exceeds_balance');
    const payment = (amount: number) => ({
      id: `p${amount}`,
      amount,
      method: 'cash' as const,
      reference: null,
      recordedBy: 's',
      recordedAt: at('2026-12-16T10:00:00Z'),
    });
    const partial = withPayment(base, payment(13_333));
    expect(partial.status).toBe('pending_payment');
    const paid = withPayment(partial, payment(20_000));
    expect(paid).toMatchObject({ status: 'paid', paidAt: at('2026-12-16T10:00:00Z') });
  });

  it('réglage du délai borné de 1 à 90 jours', () => {
    expect(billingSettingsProblems({ paymentTermDays: 10 })).toEqual([]);
    expect(billingSettingsProblems({ paymentTermDays: 0 })).toEqual(['paymentTermDays']);
    expect(billingSettingsProblems({ paymentTermDays: 91 })).toEqual(['paymentTermDays']);
  });
});
