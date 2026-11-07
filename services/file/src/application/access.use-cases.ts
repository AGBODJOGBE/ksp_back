import { requireUser } from '@ksp/platform';
import { isOwnedBy, sameSubject, type StoredFile } from '../domain/stored-file';
import { type FileDeps } from './ports';
import { requireServiceScope } from './shared/access';
import { FileErrors } from './shared/errors';
import { requireSubject, requireUuid } from './shared/validation';

const HOUR_MS = 3_600_000;
/** Fichiers d'un objet rendus par ListFiles, au plus. */
export const MAX_LISTED_FILES = 200;

export interface DownloadLink {
  url: string;
  expiresAt: Date;
}

/** Adresse de lecture de courte durée d'un fichier disponible (jamais journalisée). */
async function downloadLink(deps: FileDeps, file: StoredFile): Promise<DownloadLink> {
  if (file.status !== 'available') throw FileErrors.notAvailable();
  const ttl = deps.settings.downloadUrlTtlSeconds;
  const url = await deps.storage.presignDownload(file.storageKey, {
    fileName: file.fileName,
    contentType: file.contentType,
    expiresInSeconds: ttl,
  });
  return { url, expiresAt: new Date(deps.clock.now().getTime() + ttl * 1000) };
}

/** Fichier du compte connecté ; celui d'un autre compte est introuvable (404, sans le révéler). */
async function ownFile(deps: FileDeps, fileId: string): Promise<StoredFile> {
  const user = requireUser();
  const file = await deps.files.findById(requireUuid('fileId', fileId));
  if (!file || !isOwnedBy(file, user.userId)) throw FileErrors.notFound();
  return file;
}

export class GetMyFileUseCase {
  constructor(private readonly deps: FileDeps) {}

  execute(fileId: string): Promise<StoredFile> {
    return ownFile(this.deps, fileId);
  }
}

/**
 * Adresse de lecture pour le propriétaire. Toute autre personne passe par le service responsable
 * de l'objet, seul à connaître ses droits (CreateDownloadUrl).
 */
export class CreateMyDownloadUrlUseCase {
  constructor(private readonly deps: FileDeps) {}

  async execute(fileId: string): Promise<DownloadLink> {
    return downloadLink(this.deps, await ownFile(this.deps, fileId));
  }
}

/**
 * Fichier vu par un service : d'une de ses finalités, rattaché à l'objet qu'il désigne, pas
 * supprimé. Sinon introuvable.
 */
async function subjectFile(
  deps: FileDeps,
  input: { fileId?: string; subject?: { type?: string; id?: string } | null },
): Promise<StoredFile | null> {
  const scope = requireServiceScope();
  const fileId = requireUuid('fileId', input.fileId);
  const subject = requireSubject(input.subject);
  const file = await deps.files.findById(fileId);
  const visible =
    file !== null &&
    file.status !== 'deleted' &&
    scope.purposes.includes(file.purpose) &&
    sameSubject(file.subject, subject);
  return visible ? file : null;
}

/**
 * Rattachement d'un fichier envoyé par un compte à un objet du service responsable : le fichier
 * doit être disponible, d'une finalité du service, et envoyé par le compte au nom duquel le service
 * agit. Idempotent pour le même objet ; un autre objet : FILE_ALREADY_ATTACHED.
 */
export class AttachFileUseCase {
  constructor(private readonly deps: FileDeps) {}

  async execute(input: {
    fileId?: string;
    subject?: { type?: string; id?: string } | null;
    ownerId?: string;
  }): Promise<StoredFile> {
    const scope = requireServiceScope();
    const fileId = requireUuid('fileId', input.fileId);
    const subject = requireSubject(input.subject);
    const ownerId = requireUuid('ownerId', input.ownerId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const file = await this.deps.files.findById(fileId);
      if (!file || file.status === 'deleted' || !scope.purposes.includes(file.purpose)) {
        throw FileErrors.notFound();
      }
      if (file.ownerId !== ownerId) throw FileErrors.ownerMismatch();
      if (sameSubject(file.subject, subject)) return file;
      if (file.subject) throw FileErrors.alreadyAttached();
      if (file.status !== 'available') throw FileErrors.notAvailable();
      const attachedAt = this.deps.clock.now();
      const attachedBy = scope.service ?? 'unknown';
      if (await this.deps.files.attach(file.id, { subject, attachedBy, attachedAt })) {
        return { ...file, subject, attachedBy, attachedAt };
      }
      // Rattachement ou suppression simultanés : relu, puis jugé sur l'état enregistré.
    }
    throw FileErrors.alreadyAttached();
  }
}

/** Fichiers disponibles d'un objet (finalités du service), avec au besoin leurs adresses de lecture. */
export class ListFilesUseCase {
  constructor(private readonly deps: FileDeps) {}

  async execute(input: {
    subject?: { type?: string; id?: string } | null;
    includeDownloadUrls?: boolean;
  }): Promise<{ file: StoredFile; download: DownloadLink | null }[]> {
    const scope = requireServiceScope();
    const subject = requireSubject(input.subject);
    const files = await this.deps.files.listBySubject(subject, scope.purposes, MAX_LISTED_FILES);
    return Promise.all(
      files.map(async (file) => ({
        file,
        download: input.includeDownloadUrls ? await downloadLink(this.deps, file) : null,
      })),
    );
  }
}

/**
 * Adresse de lecture demandée par le service responsable de l'objet, pour un utilisateur qu'il a
 * lui-même autorisé (superviseur d'une mission…) : file ne connaît pas les règles métier.
 */
export class CreateDownloadUrlUseCase {
  constructor(private readonly deps: FileDeps) {}

  async execute(input: {
    fileId?: string;
    subject?: { type?: string; id?: string } | null;
  }): Promise<{ file: StoredFile; download: DownloadLink }> {
    const file = await subjectFile(this.deps, input);
    if (!file) throw FileErrors.notFound();
    return { file, download: await downloadLink(this.deps, file) };
  }
}

/**
 * Suppression logique par le service responsable de l'objet : le fichier n'est plus lisible, son
 * contenu est effacé après le délai de grâce (erreur de manipulation rattrapable). Idempotente : un
 * fichier déjà supprimé ou effacé ne lève pas d'erreur.
 */
export class DeleteFileUseCase {
  constructor(private readonly deps: FileDeps) {}

  async execute(input: { fileId?: string; subject?: { type?: string; id?: string } | null }): Promise<void> {
    const scope = requireServiceScope();
    const fileId = requireUuid('fileId', input.fileId);
    const subject = requireSubject(input.subject);
    const file = await this.deps.files.findById(fileId);
    if (!file || file.status === 'deleted') return;
    if (!scope.purposes.includes(file.purpose) || !sameSubject(file.subject, subject)) {
      throw FileErrors.notFound();
    }
    const now = this.deps.clock.now();
    await this.deps.files.softDelete(file.id, {
      reason: 'deleted_by_service',
      deletedAt: now,
      eraseAfter: new Date(now.getTime() + this.deps.settings.eraseDelayHours * HOUR_MS),
    });
  }
}
