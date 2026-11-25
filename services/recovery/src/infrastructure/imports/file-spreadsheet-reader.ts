import { type fileV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { CaseErrors } from '../../application/cases/case-errors';
import { type SpreadsheetReader } from '../../application/cases/ports';
import { RecoveryErrors } from '../../application/shared/errors';
import { type ImportLineValues, type ImportRow } from '../../domain/import';
import { callDependency } from '../grpc/dependency';
import { isZip, parseCsv, parseXlsx, type SheetRow, SpreadsheetError } from './spreadsheet';

/** Taille maximale d'un tableur (finalité `recovery_import` de file, ADR-060). */
export const MAX_SHEET_BYTES = 5 * 1024 * 1024;
const LIMITS = { maxRows: 1_001, maxColumns: 12, maxPartBytes: 20 * 1024 * 1024 };
const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_VALUE_LENGTH = 300;

/** Colonnes du modèle de tableur, dans l'ordre (message `ImportLineValues` du contrat). */
export const TEMPLATE_COLUMNS: readonly (keyof ImportLineValues)[] = [
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

/** Date à la française « JJ/MM/AAAA » → « AAAA-MM-JJ » ; toute autre valeur reste telle quelle. */
function isoDay(value: string): string {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  return match ? `${match[3]}-${match[2]!.padStart(2, '0')}-${match[1]!.padStart(2, '0')}` : value;
}

/** Numéro béninois saisi comme un nombre : le zéro de tête de « 01 » perdu par le tableur est rendu. */
function phone(value: string): string {
  const trimmed = value.trim();
  return /^1\d{8}$/.test(trimmed) ? `0${trimmed}` : value;
}

function valuesOf(cells: readonly string[]): ImportLineValues {
  const values = {} as ImportLineValues;
  TEMPLATE_COLUMNS.forEach((field, index) => {
    const raw = (cells[index] ?? '').slice(0, MAX_VALUE_LENGTH);
    values[field] = field === 'dueDate' ? isoDay(raw) : field === 'debtorPhone' ? phone(raw) : raw;
  });
  return values;
}

/**
 * Lignes de données : la première ligne non vide est l'en-tête du modèle (refusée si elle porte déjà
 * des données) ; chaque ligne garde son numéro dans le fichier, en-tête exclu.
 */
export function importRows(rows: readonly SheetRow[]): ImportRow[] {
  const [header, ...data] = rows;
  if (!header) return [];
  const kind = (header.cells[0] ?? '').trim().toLowerCase();
  if (kind === 'person' || kind === 'company') {
    throw CaseErrors.importFileInvalid(
      'header_missing',
      'La première ligne doit reprendre les intitulés des colonnes du modèle.',
    );
  }
  return data.map((row) => ({ row: row.number - header.number, values: valuesOf(row.cells) }));
}

/**
 * Tableur d'import lu chez file (FileInternalService, jeton de service de recovery) : rattaché à
 * l'import au nom du créancier (il doit l'avoir envoyé lui-même), lu par une adresse présignée de
 * courte durée, jamais journalisée. 5 Mo au plus, 1 000 lignes de données au plus.
 */
export class FileSpreadsheetReader implements SpreadsheetReader {
  constructor(
    private readonly client: fileV1.FileInternalServiceClient,
    private readonly caller: GrpcCaller,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async read(input: {
    fileId: string;
    subject: { type: string; id: string };
    ownerId: string;
  }): Promise<ImportRow[]> {
    await callDependency<fileV1.AttachFileResponse>(
      'file',
      this.caller,
      'attachFile',
      (metadata) => this.client.attachFile(input, metadata),
      { idempotent: true },
    );
    const res = await callDependency<fileV1.CreateDownloadUrlResponse>(
      'file',
      this.caller,
      'createDownloadUrl',
      (metadata) => this.client.createDownloadUrl({ fileId: input.fileId, subject: input.subject }, metadata),
      { idempotent: true },
    );
    if (Number(res.file?.sizeBytes ?? 0) > MAX_SHEET_BYTES) {
      throw CaseErrors.importFileInvalid('too_large', 'Le tableur dépasse 5 Mo.');
    }
    const url = res.download?.url;
    if (!url) throw RecoveryErrors.dependencyUnavailable('file');
    const buffer = await this.download(url);
    try {
      return importRows(isZip(buffer) ? parseXlsx(buffer, LIMITS) : parseCsv(buffer, LIMITS));
    } catch (error) {
      if (error instanceof SpreadsheetError) throw CaseErrors.importFileInvalid(error.reason, error.message);
      throw error;
    }
  }

  private async download(url: string): Promise<Buffer> {
    let response: Response;
    try {
      response = await this.fetcher(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch {
      throw RecoveryErrors.dependencyUnavailable('file');
    }
    if (!response.ok) throw RecoveryErrors.dependencyUnavailable('file');
    if (Number(response.headers.get('content-length') ?? 0) > MAX_SHEET_BYTES) {
      throw CaseErrors.importFileInvalid('too_large', 'Le tableur dépasse 5 Mo.');
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_SHEET_BYTES)
      throw CaseErrors.importFileInvalid('too_large', 'Le tableur dépasse 5 Mo.');
    return buffer;
  }
}
