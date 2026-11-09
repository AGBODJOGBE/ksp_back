import { isPurpose, type Purpose } from '../../domain/purposes';
import { type FileSubject, sanitizeFileName, SUBJECT_TYPE } from '../../domain/stored-file';
import { FileErrors } from './errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Identifiant d'un objet métier : UUID, ou référence courte (lettres, chiffres, « _ », « - »). */
const SUBJECT_ID = /^[A-Za-z0-9_-]{1,100}$/;

export function requireUuid(field: string, value: string | undefined): string {
  if (!value || !UUID.test(value)) throw FileErrors.invalid(field, 'Identifiant invalide.');
  return value.toLowerCase();
}

export function requirePurpose(value: string | undefined): Purpose {
  if (!value || !isPurpose(value)) throw FileErrors.invalid('purpose', 'Finalité inconnue.');
  return value;
}

export function requireFileName(value: string | undefined): string {
  const name = sanitizeFileName(value ?? '');
  if (!name) throw FileErrors.invalid('fileName', 'Nom de fichier invalide.');
  return name;
}

/** Type MIME en minuscules, sans paramètre (`image/jpeg; charset=…` → `image/jpeg`). */
export function normalizeContentType(value: string | undefined): string {
  const type = (value ?? '').split(';')[0]!.trim().toLowerCase();
  if (!type) throw FileErrors.invalid('contentType', 'Type de fichier obligatoire.');
  return type;
}

export function requireSize(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    throw FileErrors.invalid('sizeBytes', 'Taille invalide.');
  }
  return value;
}

export function requireSubject(value: { type?: string; id?: string } | null | undefined): FileSubject {
  const type = value?.type ?? '';
  const id = value?.id ?? '';
  if (!SUBJECT_TYPE.test(type)) throw FileErrors.invalid('subject.type', 'Type d’objet invalide.');
  if (!SUBJECT_ID.test(id)) throw FileErrors.invalid('subject.id', 'Identifiant d’objet invalide.');
  return { type, id: UUID.test(id) ? id.toLowerCase() : id };
}

/** Identifiant de compte facultatif : chaîne vide = absent. */
export function optionalUuid(field: string, value: string | undefined): string | null {
  return value ? requireUuid(field, value) : null;
}
