import { type ImportLineValues, type ImportRow, normalizeBeninPhone, validateImport } from './import';

const TODAY = '2026-11-20';

const VALUES: ImportLineValues = {
  debtorKind: 'company',
  debtorName: 'Société Alpha',
  debtorFirstNames: '',
  debtorIfu: '3201900000001',
  debtorPhone: '+229 01 97 00 00 01',
  debtorEmail: '',
  debtorAddress: '',
  invoiceReference: '',
  amount: '120 000',
  dueDate: '2026-10-15',
  description: '',
  nature: 'unpaid_invoice',
};

function line(row: number, overrides: Partial<ImportLineValues> = {}): ImportRow {
  return { row, values: { ...VALUES, invoiceReference: `FAC-${row}`, ...overrides } };
}

const errorsOf = (report: ReturnType<typeof validateImport>) =>
  report.lines.flatMap((l) => l.errors.map((e) => `${l.row}:${e.field}:${e.code}`));

describe('téléphones du Bénin', () => {
  it('normalise au format E.164 à 10 chiffres, ancien numéro à 8 chiffres converti', () => {
    expect(normalizeBeninPhone('+229 01 97 00 00 01')).toBe('+2290197000001');
    expect(normalizeBeninPhone('00229-97.00.00.01')).toBe('+2290197000001');
    expect(normalizeBeninPhone('97000001')).toBe('+2290197000001');
    expect(normalizeBeninPhone('0197000001')).toBe('+2290197000001');
    expect(normalizeBeninPhone('+229 02 97 00 00 01')).toBeNull();
    expect(normalizeBeninPhone('12345')).toBeNull();
  });
});

describe('import par tableur (R-SD-01, R-SD-02)', () => {
  it('regroupe les factures en un dossier par débiteur', () => {
    const report = validateImport(
      [
        line(1, { description: 'Livraison de septembre' }),
        line(2, { amount: '80 000' }),
        line(3, {
          debtorKind: 'person',
          debtorName: 'Koffi',
          debtorFirstNames: 'Ange',
          debtorIfu: '',
          debtorPhone: '97000002',
          amount: '30.000',
        }),
        line(4, {
          debtorKind: 'person',
          debtorName: 'Koffi',
          debtorIfu: '',
          debtorPhone: '+229 97 00 00 02',
        }),
        line(5, {
          debtorIfu: '',
          debtorPhone: '97000003',
          debtorEmail: 'compta@beta.bj',
          debtorAddress: 'Akpakpa',
        }),
        // Même numéro qu'une société sans IFU, mais une personne : un autre débiteur.
        line(6, {
          debtorKind: 'person',
          debtorName: 'Ama B.',
          debtorIfu: '',
          debtorPhone: '+229 01 97 00 00 03',
        }),
      ],
      TODAY,
      25_000,
    );
    expect(errorsOf(report)).toEqual([]);
    expect(report.lines.every((l) => l.status === 'valid')).toBe(true);
    expect(report.groups.map((g) => [g.debtorKey, g.rows.length, g.total])).toEqual([
      ['ifu:3201900000001', 2, 200_000],
      ['person:phone:+2290197000002', 2, 150_000],
      ['company:phone:+2290197000003', 1, 120_000],
      ['person:phone:+2290197000003', 1, 120_000],
    ]);
    expect(report.groups[0]!.rows[0]).toMatchObject({
      description: 'Livraison de septembre',
      debtorEmail: null,
    });
    expect(report.groups[1]!.rows[0]).toMatchObject({ debtorFirstNames: 'Ange', debtorIfu: null });
    expect(report.groups[2]!.rows[0]).toMatchObject({
      debtorEmail: 'compta@beta.bj',
      debtorAddress: 'Akpakpa',
    });
  });

  it('signale chaque erreur à sa ligne, avec le champ et le code du contrat', () => {
    const report = validateImport(
      [
        line(1, {
          debtorKind: 'state',
          debtorName: ' ',
          debtorPhone: '123',
          debtorEmail: 'pas-un-email',
          invoiceReference: '',
          nature: 'gift',
          amount: '12,5',
          dueDate: '2026-02-30',
        }),
        line(2, { debtorPhone: '', dueDate: '2026-12-01' }),
        line(3, { dueDate: '' }),
      ],
      TODAY,
      25_000,
    );
    expect(report.groups).toEqual([]);
    expect(report.lines.map((l) => l.status)).toEqual(['invalid', 'invalid', 'invalid']);
    expect(errorsOf(report)).toEqual([
      '1:debtor_kind:debtor_kind_invalid',
      '1:debtor_name:debtor_name_missing',
      '1:debtor_phone:phone_invalid',
      '1:debtor_email:email_invalid',
      '1:invoice_reference:invoice_reference_missing',
      '1:nature:nature_invalid',
      '1:amount:amount_invalid',
      '1:due_date:due_date_invalid',
      '2:debtor_phone:phone_missing',
      '2:due_date:due_date_not_reached',
      '3:due_date:due_date_missing',
    ]);
  });

  it('refuse une référence en double et un dossier sous le montant minimum (R-SD-05), ignore une ligne vide', () => {
    const blank: ImportRow = {
      row: 4,
      values: Object.fromEntries(Object.keys(VALUES).map((key) => [key, ' '])) as unknown as ImportLineValues,
    };
    const report = validateImport(
      [
        line(1),
        line(2, { invoiceReference: 'FAC-1' }),
        line(3, { debtorIfu: '999', amount: '10000', nature: '' }),
        blank,
      ],
      TODAY,
      25_000,
    );
    expect(report.groups.map((g) => g.total)).toEqual([120_000]);
    expect(report.lines.map((l) => [l.row, l.status])).toEqual([
      [1, 'valid'],
      [2, 'invalid'],
      [3, 'invalid'],
      [4, 'ignored'],
    ]);
    expect(errorsOf(report)).toEqual([
      '2:invoice_reference:invoice_reference_duplicate',
      '3:amount:amount_below_minimum',
    ]);
  });
});
