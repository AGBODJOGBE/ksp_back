import { type ImportLineValues, type ImportRow } from '../../domain/import';
import { asOtherCreditor, caseWorld, type CaseWorld, FILE_1, FILE_2 } from '../testing/case-scenarios';
import { asCreditor, CREDITOR_ID, rejection } from '../testing/fakes';

const SHEET = '0192f1c4-0000-7000-8000-00000005ee71';

const values = (change: Partial<ImportLineValues>): ImportLineValues => ({
  debtorKind: 'company',
  debtorName: 'SARL Atlantique',
  debtorFirstNames: '',
  debtorIfu: '3201900000002',
  debtorPhone: '97000201',
  debtorEmail: '',
  debtorAddress: 'Ganhi, Cotonou',
  invoiceReference: 'A-1',
  amount: '100 000',
  dueDate: '2026-10-01',
  description: '',
  nature: '',
  ...change,
});

/** Tableur : deux débiteurs valides (trois factures), une ligne au téléphone faux, une ligne vide. */
const rows = (): ImportRow[] => [
  { row: 1, values: values({}) },
  { row: 2, values: values({ invoiceReference: 'A-2', amount: '50000' }) },
  {
    row: 3,
    values: values({
      debtorKind: 'person',
      debtorName: 'Dossou',
      debtorFirstNames: 'Koffi',
      debtorIfu: '',
      debtorPhone: '96000301',
      invoiceReference: 'B-1',
      amount: '80000',
    }),
  },
  {
    row: 4,
    values: values({
      debtorKind: 'person',
      debtorName: 'Agbo',
      debtorIfu: '',
      debtorPhone: '12',
      invoiceReference: 'C-1',
    }),
  },
  {
    row: 5,
    values: values({
      debtorKind: '',
      debtorName: '',
      debtorIfu: '',
      debtorPhone: '',
      debtorAddress: '',
      invoiceReference: '',
      amount: '',
      dueDate: '',
    }),
  },
];

describe('import de dossiers par tableur (R-SD-01, R-SD-02, UC-RC-02)', () => {
  let world: CaseWorld;

  beforeEach(() => {
    world = caseWorld();
    world.deps.spreadsheets.files.set(SHEET, rows());
  });

  const create = (key = 'import-key-001', fileId = SHEET) =>
    asCreditor(() =>
      world.useCases.createCaseImport.execute({
        idempotencyKey: key,
        kind: 'b2b',
        fileId,
        evidenceArchiveFileId: '',
      }),
    );

  it('contrôle chaque ligne sans rien créer ; rejeu de la même clé', async () => {
    const imported = await create();
    expect(imported.record).toMatchObject({ status: 'checked', kind: 'b2b', fileId: SHEET });
    expect(imported.record.lines.map((line) => [line.row, line.status])).toEqual([
      [1, 'valid'],
      [2, 'valid'],
      [3, 'valid'],
      [4, 'invalid'],
      [5, 'ignored'],
    ]);
    expect(imported.record.lines[3]!.errors).toEqual([{ field: 'debtor_phone', code: 'phone_invalid' }]);
    expect(imported.casesPlanned).toBe(2);
    expect(world.deps.spreadsheets.reads).toEqual([
      {
        fileId: SHEET,
        subject: { type: 'recovery_case_import', id: imported.record.id },
        ownerId: CREDITOR_ID,
      },
    ]);
    expect(world.deps.cases.cases.size).toBe(0);
    expect((await create()).record.id).toBe(imported.record.id);
    world.deps.spreadsheets.files.set(FILE_2, rows());
    expect((await rejection(create('import-key-001', FILE_2))).code).toBe('RECOVERY_IDEMPOTENCY_KEY_REUSED');
  });

  it('fichier illisible : RECOVERY_IMPORT_FILE_INVALID ; import d’un autre créancier : introuvable', async () => {
    expect((await rejection(create('import-key-002', FILE_1))).code).toBe('RECOVERY_IMPORT_FILE_INVALID');
    const imported = await create();
    const foreign = await rejection(
      asOtherCreditor(() => world.useCases.getCaseImport.execute({ importId: imported.record.id })),
    );
    expect(foreign.code).toBe('RECOVERY_IMPORT_NOT_FOUND');
  });

  it('corrige une ligne en erreur, en ignore une autre, puis confirme : un brouillon par débiteur', async () => {
    const imported = await create();
    const importId = imported.record.id;
    const fixed = await asCreditor(() =>
      world.useCases.updateCaseImportLine.execute({
        importId,
        row: 4,
        values: values({
          debtorKind: 'person',
          debtorName: 'Agbo',
          debtorIfu: '',
          debtorPhone: '0195000401',
          invoiceReference: 'C-1',
        }),
        ignore: false,
      }),
    );
    expect(fixed.record.lines[3]!.status).toBe('valid');
    expect(fixed.casesPlanned).toBe(3);
    const ignored = await asCreditor(() =>
      world.useCases.updateCaseImportLine.execute({ importId, row: 3, values: null, ignore: true }),
    );
    expect(ignored.record.lines[2]!.status).toBe('ignored');
    expect(ignored.casesPlanned).toBe(2);

    const confirmed = await asCreditor(() =>
      world.useCases.confirmCaseImport.execute({ importId, idempotencyKey: 'confirm-key-001' }),
    );
    expect(confirmed.record.status).toBe('confirmed');
    expect(confirmed.caseIds).toHaveLength(2);
    const drafts = confirmed.caseIds.map((id) => world.deps.cases.cases.get(id)!);
    expect(drafts.map((draft) => [draft.number, draft.source, draft.status, draft.principal])).toEqual([
      ['RC-000001', 'import', 'draft', 150_000],
      ['RC-000002', 'import', 'draft', 100_000],
    ]);
    expect(drafts[0]!.debtors[0]).toMatchObject({
      kind: 'company',
      legalName: 'SARL Atlantique',
      ifu: '3201900000002',
    });
    expect(drafts[0]!.debtors[0]!.contacts[0]!.value).toBe('+2290197000201');
    expect(drafts[0]!.claims.map((claim) => claim.reference)).toEqual(['A-1', 'A-2']);
    expect(drafts[0]!.importId).toBe(importId);
    expect(confirmed.record.lines.map((line) => line.caseId !== null)).toEqual([
      true,
      true,
      false,
      true,
      false,
    ]);
    // Rejeu : rien de plus ; une ligne ne se corrige plus.
    const again = await asCreditor(() =>
      world.useCases.confirmCaseImport.execute({ importId, idempotencyKey: 'confirm-key-001' }),
    );
    expect(again.caseIds).toEqual(confirmed.caseIds);
    expect(world.deps.cases.cases.size).toBe(2);
    const late = await rejection(
      asCreditor(() =>
        world.useCases.updateCaseImportLine.execute({ importId, row: 1, values: values({}), ignore: true }),
      ),
    );
    expect(late.code).toBe('RECOVERY_INVALID_TRANSITION');
  });

  it('un brouillon importé reçoit ses pièces avant le mandat', async () => {
    const imported = await create();
    const confirmed = await asCreditor(() =>
      world.useCases.confirmCaseImport.execute({
        importId: imported.record.id,
        idempotencyKey: 'confirm-key-001',
      }),
    );
    const caseId = confirmed.caseIds[0]!;
    const missing = await rejection(
      asCreditor(() => world.useCases.prepareMandate.execute({ caseId, duplicatesAcknowledged: false })),
    );
    expect(missing).toMatchObject({
      code: 'RECOVERY_VALIDATION_FAILED',
      details: { field: 'evidenceFileIds' },
    });
    await asCreditor(() =>
      world.useCases.addCaseDocument.execute({ caseId, fileId: FILE_1, label: 'Factures A-1, A-2' }),
    );
    const prepared = await asCreditor(() =>
      world.useCases.prepareMandate.execute({ caseId, duplicatesAcknowledged: false }),
    );
    expect(prepared.view.record.fee.amount).toBe(10_000);
  });
});
