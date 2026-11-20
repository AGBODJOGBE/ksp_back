import { tryNormalizePhone } from '@ksp/platform/phone';
import { isLocalDay, type LocalDay } from './calendar';
import { type ClaimNature } from './eligibility';

/**
 * Import de dossiers par tableur (R-SD-01, R-SD-02 ; messages `ImportLine` et `ImportLineValues` du
 * contrat) : une ligne par facture, contrôlée avant toute création ; les lignes valides sont regroupées
 * en un dossier par débiteur, les lignes en erreur restent corrigeables en ligne. La lecture du fichier
 * appartient à l'infrastructure ; une ligne entièrement vide est ignorée.
 */
export type DebtorKind = 'person' | 'company';

/** Valeurs lues d'une ligne (texte), dans l'ordre du modèle de tableur. */
export interface ImportLineValues {
  debtorKind: string;
  debtorName: string;
  debtorFirstNames: string;
  /** Identifiant fiscal unique d'une personne morale, facultatif. */
  debtorIfu: string;
  debtorPhone: string;
  debtorEmail: string;
  debtorAddress: string;
  invoiceReference: string;
  amount: string;
  dueDate: string;
  description: string;
  nature: string;
}

export interface ImportRow {
  /** Numéro de la ligne dans le fichier (en-tête exclu), pour afficher l'erreur au bon endroit. */
  row: number;
  values: ImportLineValues;
}

/** Champ en cause, nom du contrat (`ImportLineValues`, en snake_case). */
export type ImportField =
  | 'debtor_kind'
  | 'debtor_name'
  | 'debtor_phone'
  | 'debtor_email'
  | 'invoice_reference'
  | 'nature'
  | 'amount'
  | 'due_date';

export type ImportErrorCode =
  | 'debtor_kind_invalid'
  | 'debtor_name_missing'
  | 'phone_missing'
  | 'phone_invalid'
  | 'email_invalid'
  | 'invoice_reference_missing'
  | 'invoice_reference_duplicate'
  | 'nature_invalid'
  | 'amount_invalid'
  | 'amount_below_minimum'
  | 'due_date_missing'
  | 'due_date_invalid'
  | 'due_date_not_reached';

export interface ImportLineError {
  field: ImportField;
  code: ImportErrorCode;
}

export type ImportLineStatus = 'valid' | 'invalid' | 'ignored';

export interface ImportLine {
  row: number;
  status: ImportLineStatus;
  errors: ImportLineError[];
}

export interface ValidRow {
  row: number;
  debtorKind: DebtorKind;
  debtorName: string;
  debtorFirstNames: string | null;
  debtorIfu: string | null;
  debtorPhone: string;
  debtorEmail: string | null;
  debtorAddress: string | null;
  invoiceReference: string;
  nature: ClaimNature;
  amount: number;
  dueDate: LocalDay;
  description: string | null;
}

export interface ImportGroup {
  /** Clé du débiteur : IFU d'une personne morale, sinon type et téléphone. */
  debtorKey: string;
  rows: ValidRow[];
  total: number;
}

export interface ImportReport {
  /** Une ligne par ligne lue, dans l'ordre du fichier. */
  lines: ImportLine[];
  /** Dossiers prévus (`casesPlanned`), un par débiteur. */
  groups: ImportGroup[];
}

/** Natures d'une créance importée (B2B, B2C) : celles du contrat, hors loyers. */
const NATURES: ReadonlySet<string> = new Set([
  'unpaid_invoice',
  'loan',
  'acknowledgment_of_debt',
  'bounced_cheque',
  'service',
  'sale',
  'other',
]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * Numéro béninois du plan à 10 chiffres issu d'un ancien numéro : +229 01 suivi de 8 chiffres.
 * Mobiles et fixes ont tous reçu le préfixe 01 le 30/11/2024 (ADR-063).
 */
const BENIN_TEN_DIGITS = /^\+22901\d{8}$/;

/**
 * Téléphone du Bénin au format E.164, plan à 10 chiffres : +229 01 suivi de 8 chiffres. Un ancien
 * numéro à 8 chiffres est converti par la règle commune du kit (ADR-063). Espaces, points, tirets et
 * préfixe 00229 tolérés ; un numéro sans indicatif est lu comme béninois. Null si le numéro est
 * invalide ou étranger.
 */
export function normalizeBeninPhone(raw: string): string | null {
  const compact = raw.replace(/[\s.\-()]/g, '');
  const international = /^(01)?\d{8}$/.test(compact) ? `+229${compact}` : compact;
  const phone = tryNormalizePhone(international);
  return phone !== null && BENIN_TEN_DIGITS.test(phone) ? phone : null;
}

/** Montant entier en FCFA ; les séparateurs de milliers (espaces, insécables compris, et points) sont tolérés. */
function parseAmount(raw: string): number | null {
  const compact = raw.replace(/[\s.]/g, '');
  if (!/^\d+$/.test(compact)) return null;
  const value = Number(compact);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

const optional = (value: string): string | null => value.trim() || null;

function isBlank(values: ImportLineValues): boolean {
  return Object.values(values).every((value) => value.trim() === '');
}

function validateRow(input: ImportRow, today: LocalDay): { row: ValidRow | null; errors: ImportLineError[] } {
  const v = input.values;
  const errors: ImportLineError[] = [];
  const fail = (field: ImportField, code: ImportErrorCode) => errors.push({ field, code });
  const kind = v.debtorKind.trim();
  if (kind !== 'person' && kind !== 'company') fail('debtor_kind', 'debtor_kind_invalid');
  const name = v.debtorName.trim();
  if (name === '') fail('debtor_name', 'debtor_name_missing');
  const phone = normalizeBeninPhone(v.debtorPhone);
  if (v.debtorPhone.trim() === '') fail('debtor_phone', 'phone_missing');
  else if (phone === null) fail('debtor_phone', 'phone_invalid');
  const email = optional(v.debtorEmail);
  if (email !== null && !EMAIL.test(email)) fail('debtor_email', 'email_invalid');
  const reference = v.invoiceReference.trim();
  if (reference === '') fail('invoice_reference', 'invoice_reference_missing');
  const nature = v.nature.trim() || 'unpaid_invoice';
  if (!NATURES.has(nature)) fail('nature', 'nature_invalid');
  const amount = parseAmount(v.amount);
  if (amount === null) fail('amount', 'amount_invalid');
  const dueDate = v.dueDate.trim();
  if (dueDate === '') fail('due_date', 'due_date_missing');
  else if (!isLocalDay(dueDate)) fail('due_date', 'due_date_invalid');
  else if (dueDate > today) fail('due_date', 'due_date_not_reached');
  if (errors.length > 0) return { row: null, errors };
  return {
    errors,
    row: {
      row: input.row,
      debtorKind: kind as DebtorKind,
      debtorName: name,
      debtorFirstNames: optional(v.debtorFirstNames),
      debtorIfu: optional(v.debtorIfu),
      debtorPhone: phone!,
      debtorEmail: email,
      debtorAddress: optional(v.debtorAddress),
      invoiceReference: reference,
      nature: nature as ClaimNature,
      amount: amount!,
      dueDate,
      description: optional(v.description),
    },
  };
}

function debtorKey(row: ValidRow): string {
  // Le type entre dans la clé : une personne et une société sans IFU au même numéro restent distinctes.
  return row.debtorKind === 'company' && row.debtorIfu !== null
    ? `ifu:${row.debtorIfu}`
    : `${row.debtorKind}:phone:${row.debtorPhone}`;
}

/**
 * Contrôle d'un fichier : erreurs ligne par ligne, références de facture en double refusées (la
 * seconde ligne), puis un dossier par débiteur ; un dossier sous le montant minimum (R-SD-05) est
 * refusé en entier, chacune de ses lignes signalée.
 */
export function validateImport(
  rows: readonly ImportRow[],
  today: LocalDay,
  minimumCaseAmount: number,
): ImportReport {
  const lines = new Map<number, ImportLine>();
  const seen = new Set<string>();
  const byDebtor = new Map<string, ValidRow[]>();
  for (const input of rows) {
    if (isBlank(input.values)) {
      lines.set(input.row, { row: input.row, status: 'ignored', errors: [] });
      continue;
    }
    const { row, errors } = validateRow(input, today);
    const line: ImportLine = { row: input.row, status: errors.length > 0 ? 'invalid' : 'valid', errors };
    lines.set(input.row, line);
    if (row === null) continue;
    if (seen.has(row.invoiceReference)) {
      line.status = 'invalid';
      line.errors.push({ field: 'invoice_reference', code: 'invoice_reference_duplicate' });
      continue;
    }
    seen.add(row.invoiceReference);
    const key = debtorKey(row);
    byDebtor.set(key, [...(byDebtor.get(key) ?? []), row]);
  }
  const groups: ImportGroup[] = [];
  for (const [key, groupRows] of byDebtor) {
    const total = groupRows.reduce((sum, row) => sum + row.amount, 0);
    if (total < minimumCaseAmount) {
      for (const row of groupRows) {
        const line = lines.get(row.row)!;
        line.status = 'invalid';
        line.errors.push({ field: 'amount', code: 'amount_below_minimum' });
      }
      continue;
    }
    groups.push({ debtorKey: key, rows: groupRows, total });
  }
  return { lines: [...lines.values()].sort((a, b) => a.row - b.row), groups };
}
