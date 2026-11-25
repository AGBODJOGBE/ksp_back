import {
  type CommissionCollection,
  commissionInvoiceLines,
  commissionTotals,
  commissionInvoiceYear,
  draftCommissionInvoice,
  formatCommissionInvoiceNumber,
  parsePeriod,
  periodLabel,
  receivedOn,
} from './commission-invoice';
import { caseNumberIn, feeReceiptKind, feeReceiptYear, formatFeeReceiptNumber } from './fee-receipt';
import { billingMonth } from './monthly-invoice';

const at = (iso: string) => new Date(iso);
const CREDITOR = { type: 'user' as const, id: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e11' };
let counter = 0;

function collection(overrides: Partial<CommissionCollection> = {}): CommissionCollection {
  counter += 1;
  return {
    collectionId: `0192f1c4-7a2b-7c3d-8e4f-${String(counter).padStart(12, '0')}`,
    creditor: CREDITOR,
    caseId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d5000',
    caseNumber: 'RC-000123',
    source: 'payment_link',
    gross: 100_000,
    commission: 10_000,
    settlement: 'deducted',
    receivedAt: at('2026-11-12T10:00:00Z'),
    invoiceId: null,
    ...overrides,
  };
}

describe('facture de commission du recouvrement (ADR-064)', () => {
  it('numéros FCR et RFD sur 6 chiffres, séries distinctes de FAC', () => {
    expect(formatCommissionInvoiceNumber(2026, 42)).toBe('FCR-2026-000042');
    expect(formatFeeReceiptNumber(2027, 1)).toBe('RFD-2027-000001');
  });

  it('mois AAAA-MM lu au Bénin ; année du numéro : celle du mois facturé', () => {
    const november = parsePeriod('2026-11')!;
    expect(november.start).toEqual(at('2026-10-31T23:00:00Z'));
    expect(november.end).toEqual(at('2026-11-30T23:00:00Z'));
    expect(periodLabel({ periodStart: november.start })).toBe('2026-11');
    expect(parsePeriod('2026-13')).toBeNull();
    expect(parsePeriod('2026-1')).toBeNull();
    expect(commissionInvoiceYear({ periodStart: billingMonth(2026, 12).start })).toBe(2026);
    expect(feeReceiptYear(at('2026-12-31T23:30:00Z'))).toBe(2027);
  });

  it('lignes par date d’encaissement ; totaux : retenue, à débiter, total ; jour du Bénin', () => {
    const lines = commissionInvoiceLines([
      collection({ receivedAt: at('2026-11-20T10:00:00Z'), caseNumber: 'RC-000124' }),
      collection({ receivedAt: at('2026-11-30T22:30:00Z'), commission: 0 }),
      collection({ receivedAt: at('2026-11-05T10:00:00Z'), settlement: 'invoiced', commission: 7_500 }),
    ]);
    expect(lines.map((line) => [line.position, line.caseNumber, receivedOn(line)])).toEqual([
      [1, 'RC-000123', '2026-11-05'],
      [2, 'RC-000124', '2026-11-20'],
      [3, 'RC-000123', '2026-11-30'],
    ]);
    expect(commissionTotals(lines)).toEqual({
      collected: 300_000,
      deducted: 10_000,
      invoiced: 7_500,
      total: 17_500,
    });
  });

  it('sans commission à débiter : réglée à l’émission ; un compte n’a pas d’en-tête', () => {
    const now = at('2026-11-30T23:00:00Z');
    const organization = { legalName: 'SARL', address: 'Cotonou', ifu: '3201912345678', rccm: null };
    const settled = draftCommissionInvoice({
      id: 'f',
      creditor: CREDITOR,
      month: billingMonth(2026, 11),
      collections: [collection()],
      organization,
      now,
    });
    expect(settled).toMatchObject({ status: 'paid', paidAt: now, organization: null });
    expect(settled.debit.nextAttemptAt).toBeNull();
    const due = draftCommissionInvoice({
      id: 'g',
      creditor: { type: 'organization', id: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0000' },
      month: billingMonth(2026, 11),
      collections: [collection({ settlement: 'invoiced' })],
      organization,
      now,
    });
    expect(due).toMatchObject({ status: 'pending_payment', paidAt: null, organization });
    expect(due.debit.nextAttemptAt).toEqual(now);
  });

  it('reçus : frais de dossier et forfait d’étude de recovery seulement ; numéro du dossier lu dans le libellé', () => {
    expect(feeReceiptKind({ service: 'recovery', objectType: 'recovery_case_fee' })).toBe('case_fee');
    expect(feeReceiptKind({ service: 'recovery', objectType: 'recovery_study_fee' })).toBe('study_fee');
    expect(feeReceiptKind({ service: 'recovery', objectType: 'constructor' })).toBeNull();
    expect(feeReceiptKind({ service: 'cleaning', objectType: 'recovery_case_fee' })).toBeNull();
    expect(caseNumberIn("Forfait d'étude du dossier RC-000123")).toBe('RC-000123');
    expect(caseNumberIn('Frais de dossier')).toBeNull();
  });
});
