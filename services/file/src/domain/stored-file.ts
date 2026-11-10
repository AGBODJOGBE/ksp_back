import { detectContentType } from './file-signature';
import { type ContentType, CONTENT_TYPES, policyOf, type Purpose } from './purposes';

/**
 * Fichier stocké (ADR-038). Son contenu vit dans le stockage objet sous `storageKey`, qui ne porte
 * aucune donnée personnelle (finalité et identifiant seulement).
 *
 * Cycle de vie : `pending` (déclaré, contenu attendu) → `available` (contenu vérifié) ou `rejected`
 * (contenu refusé, effacé du stockage) ; `deleted` (suppression logique) précède l'effacement
 * physique, après `eraseAfter`.
 */
export type FileStatus = 'pending' | 'available' | 'rejected' | 'deleted';
export type RejectionReason = 'size_mismatch' | 'type_mismatch' | 'malware';
export type DeletionReason = 'upload_expired' | 'never_attached' | 'deleted_by_service' | 'account_deleted';

export interface FileSubject {
  type: string;
  id: string;
}

export interface StoredFile {
  id: string;
  purpose: Purpose;
  fileName: string;
  contentType: ContentType;
  sizeBytes: number;
  storageKey: string;
  status: FileStatus;
  rejectionReason: RejectionReason | null;
  /** Compte qui a envoyé le fichier ; null pour un fichier de service ou d'un compte supprimé. */
  ownerId: string | null;
  subject: FileSubject | null;
  /** Service qui a rattaché le fichier. */
  attachedBy: string | null;
  attachedAt: Date | null;
  createdAt: Date;
  completedAt: Date | null;
  deletedAt: Date | null;
  deletionReason: DeletionReason | null;
  /** Effacement physique (contenu et ligne) à partir de cette date. */
  eraseAfter: Date | null;
}

/** Longueur maximale d'un nom de fichier conservé. */
export const MAX_FILE_NAME_LENGTH = 200;
/** Type d'objet métier : snake_case, préfixé par son domaine (`cleaning_intervention`). */
export const SUBJECT_TYPE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

/**
 * Nom d'origine nettoyé : sans chemin, sans caractère de contrôle ni guillemet, espaces réduits,
 * 200 caractères au plus (extension gardée). null s'il ne reste rien.
 */
export function sanitizeFileName(raw: string): string | null {
  const base = raw.normalize('NFC').split(/[/\\]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return null;
  const chars = [...cleaned];
  if (chars.length <= MAX_FILE_NAME_LENGTH) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 ? [...cleaned.slice(dot)] : [];
  if (extension.length > 10) return chars.slice(0, MAX_FILE_NAME_LENGTH).join('');
  return [...chars.slice(0, MAX_FILE_NAME_LENGTH - extension.length), ...extension].join('');
}

/** Nom neutre, sans donnée personnelle, d'un fichier détaché d'un compte supprimé. */
export function neutralFileName(file: Pick<StoredFile, 'id' | 'contentType'>): string {
  const extension = {
    'application/pdf': 'pdf',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  }[file.contentType];
  return `${file.id}.${extension}`;
}

export function storageKeyFor(purpose: Purpose, id: string): string {
  return `${purpose}/${id}`;
}

/**
 * Clé de dépôt visée par l'adresse d'envoi présignée (ADR-050) : le contenu y est vérifié, puis
 * copié sous `storageKey`, que le client ne peut jamais écrire. Un nouvel envoi à l'adresse
 * présignée, encore valable quelques minutes, ne remplace donc pas un contenu déjà vérifié.
 */
export function incomingKeyFor(id: string): string {
  return `incoming/${id}`;
}

export function isContentType(value: string): value is ContentType {
  return (CONTENT_TYPES as readonly string[]).includes(value);
}

export type DeclarationProblem =
  | { problem: 'type_not_allowed'; allowed: readonly ContentType[] }
  | { problem: 'too_large'; maxBytes: number }
  | { problem: 'empty' };

/** Contrôle de la déclaration (type, taille) au regard de la finalité ; null si elle est acceptée. */
export function declarationProblem(
  purpose: Purpose,
  contentType: string,
  sizeBytes: number,
): DeclarationProblem | null {
  const policy = policyOf(purpose);
  if (!(policy.contentTypes as readonly string[]).includes(contentType)) {
    return { problem: 'type_not_allowed', allowed: policy.contentTypes };
  }
  if (sizeBytes <= 0) return { problem: 'empty' };
  if (sizeBytes > policy.maxBytes) return { problem: 'too_large', maxBytes: policy.maxBytes };
  return null;
}

/** Contenu tel que relu dans le stockage à la confirmation. */
export interface ReceivedContent {
  sizeBytes: number;
  /** Type enregistré par le stockage (en-tête Content-Type signé de l'envoi). */
  contentType: string | null;
  /** Premiers octets du contenu. */
  head: Uint8Array;
}

/**
 * Vérifie le contenu reçu : taille réelle égale à la taille déclarée, type enregistré égal au type
 * déclaré, et signature binaire du type déclaré. Renvoie la raison du rejet, ou null.
 */
export function contentProblem(file: StoredFile, content: ReceivedContent): RejectionReason | null {
  if (content.sizeBytes !== file.sizeBytes) return 'size_mismatch';
  const stored = content.contentType?.split(';')[0]?.trim().toLowerCase() ?? null;
  if (stored !== null && stored !== file.contentType) return 'type_mismatch';
  if (detectContentType(content.head) !== file.contentType) return 'type_mismatch';
  return null;
}

/** Fichier lisible par son propriétaire : le sien, pas supprimé. */
export function isOwnedBy(file: StoredFile, userId: string): boolean {
  return file.ownerId !== null && file.ownerId === userId && file.status !== 'deleted';
}

export function sameSubject(a: FileSubject | null, b: FileSubject): boolean {
  return a !== null && a.type === b.type && a.id === b.id;
}
