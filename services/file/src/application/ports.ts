import { type Purpose } from '../domain/purposes';
import {
  type DeletionReason,
  type FileSubject,
  type RejectionReason,
  type StoredFile,
} from '../domain/stored-file';

/**
 * Ports du service file (ADR-038). Aucun événement n'est publié pour l'instant : aucun service n'en
 * a besoin (le rattachement est un appel direct du service métier). L'outbox du modèle reste prête.
 */
export interface Clock {
  now(): Date;
}

/** Identifiants UUID v7 (triables par date de création). */
export interface IdGenerator {
  next(): string;
}

/** Issue de la vérification du contenu, enregistrée seulement si le fichier est encore en attente. */
export type Completion =
  | { status: 'available'; completedAt: Date }
  | { status: 'rejected'; reason: RejectionReason; completedAt: Date; eraseAfter: Date };

/** Effacement des fichiers d'un compte supprimé (ADR-036), idempotent par l'inbox. */
export interface AccountErasure {
  status: 'processed' | 'duplicate';
  /** Fichiers effacés : en attente, jamais rattachés, ou de finalité effacée avec le compte. */
  erased: number;
  /** Fichiers gardés (finalité conservée), détachés du compte : propriétaire retiré, nom neutre. */
  detached: number;
}

export interface FileRepository {
  create(file: StoredFile): Promise<void>;
  findById(id: string): Promise<StoredFile | null>;
  /** Enregistre l'issue de la vérification si le fichier est encore en attente ; sinon false. */
  complete(id: string, completion: Completion): Promise<boolean>;
  /** Rattache un fichier disponible pas encore rattaché ; sinon false. */
  attach(id: string, input: { subject: FileSubject; attachedBy: string; attachedAt: Date }): Promise<boolean>;
  /** Suppression logique d'un fichier pas encore supprimé ; sinon false. */
  softDelete(
    id: string,
    input: { reason: DeletionReason; deletedAt: Date; eraseAfter: Date },
  ): Promise<boolean>;
  /** Fichiers disponibles d'un objet, des finalités données, les plus anciens d'abord. */
  listBySubject(subject: FileSubject, purposes: readonly Purpose[], limit: number): Promise<StoredFile[]>;
  /** Envois du compte encore en attente (quota). */
  countPending(ownerId: string): Promise<number>;
  /** Somme des tailles déclarées par le compte depuis `since` (quota journalier). */
  declaredBytesSince(ownerId: string, since: Date): Promise<number>;
  /** Fichiers en attente déclarés avant `createdBefore` : supprimés (`upload_expired`). */
  expirePending(input: { createdBefore: Date; now: Date; limit: number }): Promise<number>;
  /** Fichiers disponibles jamais rattachés, confirmés avant `completedBefore` : supprimés. */
  expireUnattached(input: { completedBefore: Date; now: Date; limit: number }): Promise<number>;
  /** Fichiers supprimés ou rejetés dont l'effacement physique est dû. */
  listToErase(now: Date, limit: number): Promise<StoredFile[]>;
  /** Retire la ligne d'un fichier effacé du stockage (si son effacement est toujours dû). */
  remove(id: string, now: Date): Promise<void>;
  /**
   * Compte supprimé (`identity.user.deleted`), dans la même transaction que l'inbox : fichiers en
   * attente, jamais rattachés ou de finalité `erase` supprimés (effacement immédiat) ; les autres
   * détachés du compte (propriétaire retiré, nom remplacé par un nom neutre).
   */
  eraseAccount(
    userId: string,
    input: { eventId: string; consumer: string; erasedPurposes: readonly Purpose[]; now: Date },
  ): Promise<AccountErasure>;
}

/** Adresse PUT présignée et en-têtes signés à renvoyer tels quels. */
export interface PresignedUpload {
  url: string;
  headers: Record<string, string>;
}

/** Contenu tel que le stockage le décrit (HEAD). */
export interface ObjectStat {
  sizeBytes: number;
  contentType: string | null;
  /** Version du contenu (ETag) : la copie n'a lieu que si elle n'a pas changé. */
  etag: string | null;
}

/**
 * Stockage objet compatible S3 (MinIO, Object Storage de Contabo). Une panne lève une AppError
 * UNAVAILABLE ; les adresses présignées ne sont jamais journalisées.
 */
export interface ObjectStorage {
  /** Adresse PUT : type et taille signés, le stockage refuse un autre contenu. */
  presignUpload(
    key: string,
    input: { contentType: string; sizeBytes: number; expiresInSeconds: number },
  ): Promise<PresignedUpload>;
  /** Adresse GET : type et nom servis par le stockage (Content-Type, Content-Disposition). */
  presignDownload(
    key: string,
    input: { fileName: string; contentType: string; expiresInSeconds: number },
  ): Promise<string>;
  /** Description du contenu ; null s'il n'existe pas. */
  stat(key: string): Promise<ObjectStat | null>;
  /** Premiers octets du contenu (au plus `bytes`). */
  readHead(key: string, bytes: number): Promise<Uint8Array>;
  /** Efface le contenu ; sans effet s'il n'existe pas. */
  remove(key: string): Promise<void>;
  /**
   * Copie le contenu de `from` vers `to` s'il est toujours à la version `etag` (contenu vérifié) ;
   * false s'il a changé ou disparu entre-temps.
   */
  copyIfUnchanged(from: string, to: string, etag: string | null): Promise<boolean>;
}

/**
 * Antivirus : point d'extension (ADR-038). L'adaptateur par défaut n'analyse rien (`skipped`) ; un
 * adaptateur réel (ClamAV en flux, service d'analyse) se branche ici sans changer les cas d'usage.
 * Une panne lève une AppError UNAVAILABLE : la confirmation est à refaire.
 */
export interface MalwareScanner {
  scan(
    file: Pick<StoredFile, 'id' | 'storageKey' | 'contentType' | 'sizeBytes'>,
  ): Promise<'clean' | 'infected' | 'skipped'>;
}

/** Réglages des cas d'usage, lus dans la configuration du service. */
export interface FileSettings {
  /** Durée de validité d'une adresse d'envoi. */
  uploadUrlTtlSeconds: number;
  /** Durée de validité d'une adresse de lecture. */
  downloadUrlTtlSeconds: number;
  /** Délai après lequel un envoi non confirmé est purgé. */
  pendingTtlMinutes: number;
  /** Délai après lequel un fichier disponible jamais rattaché est purgé. */
  unattachedTtlHours: number;
  /** Délai de grâce entre la suppression par un service et l'effacement physique. */
  eraseDelayHours: number;
  /** Envois en attente simultanés par compte. */
  maxPendingPerOwner: number;
  /** Volume déclaré par compte sur 24 heures glissantes, en octets. */
  dailyBytesPerOwner: number;
}

export interface FileDeps {
  files: FileRepository;
  storage: ObjectStorage;
  scanner: MalwareScanner;
  settings: FileSettings;
  clock: Clock;
  ids: IdGenerator;
}
