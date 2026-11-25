import { inflateRawSync } from 'node:zlib';

/**
 * Lecture des tableurs d'import (R-SD-01) : CSV (séparateur « ; », « , » ou tabulation, UTF-8 ou
 * Windows-1252) et XLSX (archive ZIP de fichiers XML, première feuille). Lecteur volontairement
 * réduit, sans dépendance : il ne lit que les valeurs des cellules (textes partagés ou en ligne,
 * nombres, dates au format date), avec des limites de taille contre une archive piégée.
 */
export class SpreadsheetError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

/** Ligne lue : numéro dans la feuille (1 = première ligne) et cellules texte, par colonne. */
export interface SheetRow {
  number: number;
  cells: string[];
}

export interface SheetLimits {
  /** Lignes lues au plus (en-tête comprise) : au-delà, le fichier est refusé. */
  maxRows: number;
  /** Colonnes lues au plus par ligne. */
  maxColumns: number;
  /** Taille décompressée au plus d'une partie de l'archive XLSX. */
  maxPartBytes: number;
}

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;

export const isZip = (buffer: Buffer) => buffer.length >= 4 && buffer.readUInt32LE(0) === ZIP_LOCAL;

// ---------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------

function decodeText(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
  } catch {
    // Export d'Excel en Windows-1252 : les accents restent lisibles.
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

/** Séparateur le plus fréquent de la première ligne, hors guillemets. */
function detectSeparator(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const unquoted = firstLine.replace(/"[^"]*"/g, '');
  const counts = [';', ',', '\t'].map((separator) => ({
    separator,
    count: unquoted.split(separator).length - 1,
  }));
  counts.sort((a, b) => b.count - a.count);
  return counts[0]!.count > 0 ? counts[0]!.separator : ';';
}

/** CSV au sens de la RFC 4180 : champs entre guillemets, guillemets doublés, retours à la ligne. */
export function parseCsv(buffer: Buffer, limits: SheetLimits): SheetRow[] {
  const text = decodeText(buffer);
  const separator = detectSeparator(text);
  const rows: SheetRow[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let number = 1;
  const pushRow = () => {
    cells.push(cell);
    if (cells.some((value) => value.trim() !== '')) {
      if (rows.length >= limits.maxRows) {
        throw new SpreadsheetError('too_many_rows', `${limits.maxRows - 1} lignes au plus par fichier.`);
      }
      rows.push({ number, cells: cells.slice(0, limits.maxColumns) });
    }
    cells = [];
    cell = '';
    number += 1;
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"' && cell === '') {
      quoted = true;
    } else if (char === separator) {
      cells.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      pushRow();
    } else {
      cell += char;
    }
  }
  if (quoted) throw new SpreadsheetError('unreadable', 'Guillemet non refermé dans le fichier.');
  if (cell !== '' || cells.length > 0) pushRow();
  return rows;
}

// ---------------------------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------------------------

/** Parties nommées d'une archive ZIP, décompressées à la demande avec une taille maximale. */
function zipEntries(buffer: Buffer, maxPartBytes: number): (name: string) => Buffer | null {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65_535); i -= 1) {
    if (buffer.readUInt32LE(i) === ZIP_END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new SpreadsheetError('unreadable', 'Archive XLSX illisible.');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map<
    string,
    { method: number; size: number; compressed: number; local: number; flags: number }
  >();
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== ZIP_CENTRAL) {
      throw new SpreadsheetError('unreadable', 'Archive XLSX illisible.');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.set(name, { method, size, compressed, local, flags });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return (name) => {
    const entry = entries.get(name);
    if (!entry) return null;
    if (entry.flags & 0x1) throw new SpreadsheetError('unreadable', 'Archive XLSX chiffrée.');
    if (entry.size > maxPartBytes || entry.compressed === 0xffffffff) {
      throw new SpreadsheetError('too_large', 'Fichier XLSX trop volumineux une fois décompressé.');
    }
    const local = entry.local;
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== ZIP_LOCAL) {
      throw new SpreadsheetError('unreadable', 'Archive XLSX illisible.');
    }
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + entry.compressed);
    if (entry.method === 0) return Buffer.from(data);
    if (entry.method !== 8) throw new SpreadsheetError('unreadable', 'Compression XLSX non prise en charge.');
    try {
      return inflateRawSync(data, { maxOutputLength: maxPartBytes });
    } catch {
      throw new SpreadsheetError(
        'too_large',
        'Fichier XLSX illisible ou trop volumineux une fois décompressé.',
      );
    }
  };
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Texte d'un élément riche (`<si>`, `<is>`) : ses `<t>`, sans les indications phonétiques. */
function richText(xml: string): string {
  return [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
    .map((match) => decodeXml(match[1]!))
    .join('');
}

function attribute(attributes: string, name: string): string | null {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attributes);
  return match ? decodeXml(match[1]!) : null;
}

/** Formats de date intégrés d'Excel (identifiants) ; les formats propres sont reconnus à leur motif. */
const BUILT_IN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

/** Styles de cellule (index de `cellXfs`) qui affichent une date. */
function dateStyles(stylesXml: string | null): Set<number> {
  const styles = new Set<number>();
  if (!stylesXml) return styles;
  const custom = new Map<number, string>();
  for (const match of stylesXml.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const id = Number(attribute(match[1]!, 'numFmtId'));
    custom.set(id, attribute(match[1]!, 'formatCode') ?? '');
  }
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? '';
  [...cellXfs.matchAll(/<xf\b([^>]*?)(?:\/>|>)/g)].forEach((match, index) => {
    const id = Number(attribute(match[1]!, 'numFmtId') ?? 0);
    const code = (custom.get(id) ?? '').replace(/"[^"]*"|\[[^\]]*\]/g, '').toLowerCase();
    if (BUILT_IN_DATE_FORMATS.has(id) || (custom.has(id) && /[dmy]/.test(code) && !/[h0#]/.test(code))) {
      styles.add(index);
    }
  });
  return styles;
}

/** Numéro de série d'Excel (calendrier 1900) → jour « AAAA-MM-JJ ». */
export function excelSerialToDay(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2_958_465) return null;
  // 25 569 = 1970-01-01 ; Excel compte un 29 février 1900 qui n'a pas existé (série 60).
  const days = Math.floor(serial) - (serial > 60 ? 25_569 : 25_568);
  return new Date(days * 86_400_000).toISOString().slice(0, 10);
}

function columnIndex(reference: string | null, fallback: number): number {
  const letters = reference ? /^[A-Z]+/.exec(reference)?.[0] : null;
  if (!letters) return fallback;
  return [...letters].reduce((sum, letter) => sum * 26 + (letter.charCodeAt(0) - 64), 0) - 1;
}

/** Première feuille du classeur : son chemin dans l'archive. */
function firstSheetPath(read: (name: string) => Buffer | null): string {
  const workbook = read('xl/workbook.xml')?.toString('utf8');
  if (!workbook) throw new SpreadsheetError('unreadable', 'Classeur XLSX sans feuille.');
  const sheet = /<sheet\b([^>]*)\/?>/.exec(workbook)?.[1];
  const relation = sheet ? (attribute(sheet, 'r:id') ?? attribute(sheet, 'id')) : null;
  const rels = read('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  for (const match of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    if (attribute(match[1]!, 'Id') === relation) {
      const target = attribute(match[1]!, 'Target') ?? '';
      return target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    }
  }
  return 'xl/worksheets/sheet1.xml';
}

/** Valeurs de la première feuille d'un classeur XLSX. */
export function parseXlsx(buffer: Buffer, limits: SheetLimits): SheetRow[] {
  const read = zipEntries(buffer, limits.maxPartBytes);
  const sheet = read(firstSheetPath(read))?.toString('utf8');
  if (!sheet) throw new SpreadsheetError('unreadable', 'Feuille XLSX introuvable.');
  const shared = [
    ...(read('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g),
  ].map((match) => richText(match[1]!));
  const dates = dateStyles(read('xl/styles.xml')?.toString('utf8') ?? null);
  const rows: SheetRow[] = [];
  let previous = 0;
  for (const match of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const number = Number(attribute(match[1]!, 'r')) || previous + 1;
    previous = number;
    const cells: string[] = [];
    let position = 0;
    for (const cell of (match[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1]!;
      const column = columnIndex(attribute(attrs, 'r'), position);
      position = column + 1;
      if (column >= limits.maxColumns) continue;
      const type = attribute(attrs, 't');
      const content = cell[2] ?? '';
      const raw = /<v>([\s\S]*?)<\/v>/.exec(content)?.[1];
      let value = '';
      if (type === 's') value = shared[Number(raw)] ?? '';
      else if (type === 'inlineStr') value = richText(/<is>([\s\S]*?)<\/is>/.exec(content)?.[1] ?? '');
      else if (type === 'b') value = raw === '1' ? 'VRAI' : 'FAUX';
      else if (type === 'e') value = '';
      else if (raw !== undefined) {
        const style = Number(attribute(attrs, 's') ?? -1);
        value = decodeXml(raw);
        if (type !== 'str' && dates.has(style)) value = excelSerialToDay(Number(value)) ?? value;
      }
      while (cells.length < column) cells.push('');
      cells[column] = value;
    }
    if (!cells.some((value) => value.trim() !== '')) continue;
    if (rows.length >= limits.maxRows) {
      throw new SpreadsheetError('too_many_rows', `${limits.maxRows - 1} lignes au plus par fichier.`);
    }
    rows.push({ number, cells });
  }
  return rows;
}
