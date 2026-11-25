import { localDay, type LocalDay } from '../../domain/calendar';
import { type ImportLineValues, type ImportRow, validateImport, type ValidRow } from '../../domain/import';
import { loadSettings } from '../settings.use-cases';
import { currentCreditor } from '../shared/access';
import { formatXof, RecoveryErrors } from '../shared/errors';
import { creditorWriter, sameHolder } from './case-access';
import { CaseErrors } from './case-errors';
import { type CaseContent, UUID, withContent } from './case-input';
import { creditorActor, emptyCase, evidenceEntry, requireIdempotencyKey, stableId } from './case-rules';
import { type CaseDeps } from './creditor-cases.use-cases';
import {
  type CaseChanges,
  type CaseImportRecord,
  type ImportLineRecord,
  noChanges,
  type RecoveryCaseRecord,
} from './ports';

/**
 * Import de dossiers par tableur (R-SD-01, R-SD-02 ; UC-RC-02) : le fichier envoyé par file est lu et
 * contrôlé ligne par ligne (`validateImport` du domaine), sans rien créer ; les lignes en erreur se
 * corrigent ou s'ignorent en ligne ; la confirmation crée un brouillon par débiteur. Les valeurs lues
 * (coordonnées de débiteurs) sont chiffrées en base.
 */

/** Lignes au plus par fichier (50 factures pour 12 débiteurs au critère du lot B). */
export const MAX_IMPORT_ROWS = 1_000;
const MAX_VALUE_LENGTH = 300;

const VALUE_FIELDS: readonly (keyof ImportLineValues)[] = [
  'debtorKind',
  'debtorName',
  'debtorFirstNames',
  'debtorIfu',
  'debtorPhone',
  'debtorEmail',
  'debtorAddress',
  'invoiceReference',
  'amount',
  'dueDate',
  'description',
  'nature',
];

export interface ImportView {
  record: CaseImportRecord;
  /** Dossiers prévus : un par débiteur valide (créés, une fois confirmé). */
  casesPlanned: number;
  caseIds: string[];
}

const isBlank = (values: ImportLineValues) => VALUE_FIELDS.every((field) => values[field].trim() === '');

/** Ligne ignorée par le créancier (une ligne vide l'est d'office et reste contrôlée). */
const ignoredByCreditor = (line: ImportLineRecord) => line.status === 'ignored' && !isBlank(line.values);

/** Contrôle de toutes les lignes retenues : doublons de factures et minimum par dossier en dépendent. */
function revalidate(record: CaseImportRecord, today: LocalDay, minimum: number) {
  const kept = record.lines.filter((line) => !ignoredByCreditor(line));
  const report = validateImport(
    kept.map((line): ImportRow => ({ row: line.row, values: line.values })),
    today,
    minimum,
  );
  const outcome = new Map(report.lines.map((line) => [line.row, line]));
  const lines = record.lines.map((line) => {
    const checked = outcome.get(line.row);
    return checked ? { ...line, status: checked.status, errors: checked.errors } : line;
  });
  return { lines, groups: report.groups };
}

function view(record: CaseImportRecord, casesPlanned: number): ImportView {
  const caseIds = [
    ...new Set(record.lines.map((line) => line.caseId).filter((id): id is string => id !== null)),
  ];
  return { record, casesPlanned: record.status === 'confirmed' ? caseIds.length : casesPlanned, caseIds };
}

function sanitizeValues(values: Partial<ImportLineValues> | null): ImportLineValues {
  if (!values) throw RecoveryErrors.invalid('values', 'Valeurs de la ligne obligatoires.');
  const result = {} as ImportLineValues;
  for (const field of VALUE_FIELDS) {
    const value = values[field] ?? '';
    if (value.length > MAX_VALUE_LENGTH) {
      throw RecoveryErrors.invalid(`values.${field}`, `${MAX_VALUE_LENGTH} caractères au plus.`);
    }
    result[field] = value;
  }
  return result;
}

function requireImportId(importId: string): string {
  if (!UUID.test(importId ?? '')) throw CaseErrors.importNotFound();
  return importId.toLowerCase();
}

async function ownImport(deps: CaseDeps, importId: string, holder: CaseImportRecord['creditor']) {
  const record = await deps.imports.find(requireImportId(importId));
  if (!record || !sameHolder(record.creditor, holder)) throw CaseErrors.importNotFound();
  return record;
}

/** Contenu d'un brouillon issu d'un groupe de lignes (un débiteur, ses factures). */
function contentOfGroup(
  kind: 'b2b' | 'b2c',
  rows: readonly ValidRow[],
): Omit<CaseContent, 'evidenceFileIds'> {
  const first = rows[0]!;
  const emails = [...new Set(rows.map((row) => row.debtorEmail).filter((email): email is string => !!email))];
  return {
    kind,
    nature: first.nature,
    debtors: [
      {
        kind: first.debtorKind,
        role: 'main',
        firstNames: first.debtorKind === 'person' ? first.debtorFirstNames : null,
        lastName: first.debtorKind === 'person' ? first.debtorName : null,
        legalName: first.debtorKind === 'company' ? first.debtorName : null,
        ifu: first.debtorKind === 'company' ? first.debtorIfu : null,
        rccm: null,
        representativeName: null,
        address: first.debtorAddress,
        communeKey: null,
        phones: [first.debtorPhone],
        emails,
      },
    ],
    claims: rows.map((row) => ({
      reference: row.invoiceReference,
      nature: row.nature,
      principal: row.amount,
      dueDate: row.dueDate,
      description: row.description,
    })),
    interests: 0,
    alreadyPaid: 0,
    priorEffort: {
      remindersCount: 0,
      lastReminderDate: null,
      channels: [],
      acknowledged: false,
      acknowledgmentFileId: null,
      promises: null,
    },
    preserveRelationship: false,
    planScale: null,
  };
}

/**
 * Import d'un tableur (CreateCaseImport) : lu chez file au nom du créancier, contrôlé ligne par ligne,
 * enregistré « contrôlé » sans créer de dossier. Idempotent par (créancier, clé). L'archive des
 * justificatifs est notée ; son dépouillement viendra avec la finalité `recovery_evidence_archive`.
 */
export class CreateCaseImportUseCase {
  constructor(private readonly deps: CaseDeps) {}

  async execute(input: {
    idempotencyKey: string;
    kind: string;
    fileId: string;
    evidenceArchiveFileId: string;
  }): Promise<ImportView> {
    const creditor = creditorWriter();
    const now = this.deps.clock.now();
    const key = requireIdempotencyKey(input.idempotencyKey);
    if (input.kind !== 'b2b' && input.kind !== 'b2c')
      throw RecoveryErrors.invalid('kind', 'Valeur attendue : b2b, b2c.');
    if (!UUID.test(input.fileId ?? '')) throw RecoveryErrors.invalid('fileId', 'Identifiant invalide.');
    if (input.evidenceArchiveFileId && !UUID.test(input.evidenceArchiveFileId)) {
      throw RecoveryErrors.invalid('evidenceArchiveFileId', 'Identifiant invalide.');
    }
    const fileId = input.fileId.toLowerCase();
    const { settings } = await loadSettings(this.deps.settings);
    const today = localDay(now);

    const replay = (existing: CaseImportRecord) => {
      if (existing.fileId !== fileId || existing.kind !== input.kind) throw RecoveryErrors.keyReused();
      return view(existing, revalidate(existing, today, settings.minimumCaseAmount).groups.length);
    };
    const existing = await this.deps.imports.findByIdempotencyKey(creditor.holder, key);
    if (existing) return replay(existing);

    const id = stableId('recovery_case_import', creditor.holder.type, creditor.holder.id, key);
    const rows = await this.deps.spreadsheets.read({
      fileId,
      subject: { type: 'recovery_case_import', id },
      ownerId: creditor.userId,
    });
    if (rows.length === 0)
      throw CaseErrors.importFileInvalid('empty', 'Le fichier ne contient aucune ligne.');
    if (rows.length > MAX_IMPORT_ROWS) {
      throw CaseErrors.importFileInvalid('too_many_rows', `${MAX_IMPORT_ROWS} lignes au plus par fichier.`);
    }
    const report = validateImport(rows, today, settings.minimumCaseAmount);
    const checked = new Map(report.lines.map((line) => [line.row, line]));
    const record: CaseImportRecord = {
      id,
      creditor: creditor.holder,
      createdBy: creditor.userId,
      kind: input.kind,
      fileId,
      evidenceArchiveFileId: input.evidenceArchiveFileId ? input.evidenceArchiveFileId.toLowerCase() : null,
      status: 'checked',
      idempotencyKey: key,
      createdAt: now,
      updatedAt: now,
      version: 0,
      lines: rows.map((row) => ({
        row: row.row,
        values: sanitizeValues(row.values),
        status: checked.get(row.row)?.status ?? 'ignored',
        errors: checked.get(row.row)?.errors ?? [],
        caseId: null,
      })),
    };
    if ((await this.deps.imports.create(record)) === 'duplicate') {
      const raced = await this.deps.imports.findByIdempotencyKey(creditor.holder, key);
      if (raced) return replay(raced);
      throw CaseErrors.importNotFound();
    }
    return view(record, report.groups.length);
  }
}

/** Import du créancier (GetCaseImport). */
export class GetCaseImportUseCase {
  constructor(private readonly deps: CaseDeps) {}

  async execute(input: { importId: string }): Promise<ImportView> {
    const creditor = currentCreditor();
    const record = await ownImport(this.deps, input.importId, creditor.holder);
    const { settings } = await loadSettings(this.deps.settings);
    const today = localDay(this.deps.clock.now());
    return view(record, revalidate(record, today, settings.minimumCaseAmount).groups.length);
  }
}

/**
 * Correction d'une ligne avant confirmation (UpdateCaseImportLine) : nouvelles valeurs, ou ligne
 * ignorée ; tout l'import est contrôlé de nouveau (doublons, minimum par débiteur).
 */
export class UpdateCaseImportLineUseCase {
  constructor(private readonly deps: CaseDeps) {}

  async execute(input: {
    importId: string;
    row: number;
    values: Partial<ImportLineValues> | null;
    ignore: boolean;
  }): Promise<ImportView> {
    const creditor = creditorWriter();
    const now = this.deps.clock.now();
    const record = await ownImport(this.deps, input.importId, creditor.holder);
    if (record.status !== 'checked') {
      throw CaseErrors.invalidTransition(record.status, 'Seul un import contrôlé, non confirmé, se corrige.');
    }
    const line = record.lines.find((candidate) => candidate.row === input.row);
    if (!line) throw RecoveryErrors.invalid('row', 'Ligne inconnue dans cet import.');
    const edited: ImportLineRecord = input.ignore
      ? { ...line, status: 'ignored', errors: [] }
      : { ...line, values: sanitizeValues(input.values), status: 'valid', errors: [] };
    if (input.ignore && isBlank(edited.values)) {
      throw RecoveryErrors.invalid('ignore', 'Une ligne vide est déjà ignorée.');
    }
    const { settings } = await loadSettings(this.deps.settings);
    const updated: CaseImportRecord = {
      ...record,
      updatedAt: now,
      lines: record.lines.map((candidate) => (candidate.row === line.row ? edited : candidate)),
    };
    const { lines, groups } = revalidate(updated, localDay(now), settings.minimumCaseAmount);
    const next = { ...updated, lines };
    if (!(await this.deps.imports.saveLines(next))) throw CaseErrors.concurrentUpdate(record.status);
    return view({ ...next, version: record.version + 1 }, groups.length);
  }
}

/**
 * Confirmation d'un import (ConfirmCaseImport) : un brouillon par débiteur à partir des lignes valides
 * (source `import`), créé avec les lignes rattachées dans une seule transaction. Les pièces se
 * déposent ensuite par dossier ; le mandat les exige. Rejouée, elle rend l'import confirmé.
 */
export class ConfirmCaseImportUseCase {
  constructor(private readonly deps: CaseDeps) {}

  async execute(input: { importId: string; idempotencyKey: string }): Promise<ImportView> {
    const creditor = creditorWriter();
    const now = this.deps.clock.now();
    requireIdempotencyKey(input.idempotencyKey);
    const record = await ownImport(this.deps, input.importId, creditor.holder);
    if (record.status === 'confirmed') return view(record, 0);
    if (record.status !== 'checked') {
      throw CaseErrors.invalidTransition(record.status, 'Seul un import contrôlé se confirme.');
    }
    const { settings } = await loadSettings(this.deps.settings);
    const { lines, groups } = revalidate(record, localDay(now), settings.minimumCaseAmount);
    if (groups.length === 0) throw RecoveryErrors.invalid('lines', 'Aucune ligne valide à importer.');
    const preferences = await this.deps.preferences.get(creditor.holder);
    const defaultScale = (record.kind === 'b2b' ? preferences?.b2bScale : preferences?.b2cScale) ?? null;

    const caseOfRow = new Map<number, string>();
    const cases: { record: RecoveryCaseRecord; changes: CaseChanges }[] = groups.map((group) => {
      const base = emptyCase({
        id: this.deps.ids.next(),
        creditor: creditor.holder,
        createdBy: creditor.userId,
        source: 'import',
        importId: record.id,
        idempotencyKey: null,
        planScale: defaultScale,
        now,
      });
      const draft = withContent(base, contentOfGroup(record.kind, group.rows), () => this.deps.ids.next());
      for (const row of group.rows) caseOfRow.set(row.row, draft.id);
      const changes = noChanges();
      changes.evidence.push(
        evidenceEntry(this.deps.ids, draft, now, creditorActor(creditor.userId), {
          action: 'case.created',
          kind: 'status_changed',
          summary:
            `Dossier créé par import (brouillon) : ${draft.claims.length} créance(s), montant dû ` +
            `${formatXof(group.total)}`,
        }),
      );
      return { record: draft, changes };
    });
    const confirmed: CaseImportRecord = {
      ...record,
      status: 'confirmed',
      updatedAt: now,
      lines: lines.map((line) => ({ ...line, caseId: caseOfRow.get(line.row) ?? null })),
    };
    const outcome = await this.deps.imports.confirm(confirmed, cases);
    if (outcome === 'stale') {
      const latest = await this.deps.imports.find(record.id);
      if (latest?.status === 'confirmed') return view(latest, 0);
      throw CaseErrors.concurrentUpdate(record.status);
    }
    return view({ ...confirmed, version: record.version + 1 }, outcome.length);
  }
}
