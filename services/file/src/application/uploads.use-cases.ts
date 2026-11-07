import { requireUser } from '@ksp/platform';
import { SIGNATURE_BYTES } from '../domain/file-signature';
import { policyOf } from '../domain/purposes';
import {
  contentProblem,
  declarationProblem,
  type FileSubject,
  isOwnedBy,
  type RejectionReason,
  storageKeyFor,
  type StoredFile,
} from '../domain/stored-file';
import { type FileDeps } from './ports';
import { requireServiceScope } from './shared/access';
import { FileErrors } from './shared/errors';
import {
  normalizeContentType,
  optionalUuid,
  requireFileName,
  requirePurpose,
  requireSize,
  requireSubject,
  requireUuid,
} from './shared/validation';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

export interface UploadDeclaration {
  purpose?: string;
  fileName?: string;
  contentType?: string;
  sizeBytes?: number;
}

export interface UploadTicket {
  file: StoredFile;
  upload: { url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: Date };
}

/** Déclaration validée : finalité, nom nettoyé, type et taille acceptés par la finalité. */
function validateDeclaration(input: UploadDeclaration) {
  const purpose = requirePurpose(input.purpose);
  const fileName = requireFileName(input.fileName);
  const contentType = normalizeContentType(input.contentType);
  const sizeBytes = requireSize(input.sizeBytes);
  const problem = declarationProblem(purpose, contentType, sizeBytes);
  if (problem?.problem === 'type_not_allowed') throw FileErrors.typeNotAllowed(problem.allowed);
  if (problem?.problem === 'too_large') throw FileErrors.tooLarge(problem.maxBytes);
  if (problem) throw FileErrors.invalid('sizeBytes', 'Taille invalide.');
  return { purpose, fileName, contentType: contentType as StoredFile['contentType'], sizeBytes };
}

/** Enregistre le fichier en attente et prépare son adresse d'envoi présignée. */
async function openUpload(
  deps: FileDeps,
  input: ReturnType<typeof validateDeclaration> & {
    ownerId: string | null;
    subject: FileSubject | null;
    attachedBy: string | null;
  },
): Promise<UploadTicket> {
  const now = deps.clock.now();
  const id = deps.ids.next();
  const file: StoredFile = {
    id,
    purpose: input.purpose,
    fileName: input.fileName,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    storageKey: storageKeyFor(input.purpose, id),
    status: 'pending',
    rejectionReason: null,
    ownerId: input.ownerId,
    subject: input.subject,
    attachedBy: input.subject ? input.attachedBy : null,
    attachedAt: input.subject ? now : null,
    createdAt: now,
    completedAt: null,
    deletedAt: null,
    deletionReason: null,
    eraseAfter: null,
  };
  await deps.files.create(file);
  const ttl = deps.settings.uploadUrlTtlSeconds;
  const presigned = await deps.storage.presignUpload(file.storageKey, {
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    expiresInSeconds: ttl,
  });
  return {
    file,
    upload: {
      url: presigned.url,
      method: 'PUT',
      headers: presigned.headers,
      expiresAt: new Date(now.getTime() + ttl * 1000),
    },
  };
}

/**
 * Déclaration d'un envoi par le compte connecté : la finalité doit accepter l'envoi par un compte,
 * le type et la taille la respecter, et le compte rester dans son quota (envois en attente, volume
 * sur 24 heures). Le propriétaire est le compte connecté, jamais une valeur envoyée par le client ;
 * l'objet métier est fixé ensuite par le service responsable (AttachFile).
 */
export class CreateUploadUseCase {
  constructor(private readonly deps: FileDeps) {}

  async execute(input: UploadDeclaration): Promise<UploadTicket> {
    const user = requireUser();
    const declaration = validateDeclaration(input);
    if (policyOf(declaration.purpose).uploadedBy !== 'user') throw FileErrors.purposeForbidden();

    const { settings, clock, files } = this.deps;
    const pending = await files.countPending(user.userId);
    if (pending >= settings.maxPendingPerOwner) {
      throw FileErrors.quotaExceeded('pending_uploads', settings.maxPendingPerOwner);
    }
    const since = new Date(clock.now().getTime() - 24 * HOUR_MS);
    const used = await files.declaredBytesSince(user.userId, since);
    if (used + declaration.sizeBytes > settings.dailyBytesPerOwner) {
      throw FileErrors.quotaExceeded('daily_bytes', settings.dailyBytesPerOwner);
    }
    return openUpload(this.deps, { ...declaration, ownerId: user.userId, subject: null, attachedBy: null });
  }
}

/**
 * Déclaration d'un envoi par un service (PDF produit par document…) : finalité dont il est
 * responsable, fichier rattaché à son objet dès la déclaration. Pas de quota par compte.
 */
export class CreateServiceUploadUseCase {
  constructor(private readonly deps: FileDeps) {}

  async execute(
    input: UploadDeclaration & { subject?: { type?: string; id?: string } | null; ownerId?: string },
  ): Promise<UploadTicket> {
    const scope = requireServiceScope();
    const declaration = validateDeclaration(input);
    if (!scope.purposes.includes(declaration.purpose)) throw FileErrors.purposeForbidden();
    const subject = requireSubject(input.subject);
    const ownerId = optionalUuid('ownerId', input.ownerId);
    return openUpload(this.deps, {
      ...declaration,
      ownerId,
      subject,
      attachedBy: scope.service ?? 'unknown',
    });
  }
}

/**
 * Confirmation de l'envoi : le contenu est relu dans le stockage (présence, taille réelle, type
 * enregistré, signature binaire), puis soumis à l'antivirus. Conforme : `available`. Sinon
 * `rejected`, contenu effacé du stockage, et FILE_UPLOAD_REJECTED. Contenu absent : le fichier
 * reste en attente (FILE_NOT_UPLOADED) jusqu'à sa purge. Idempotente.
 */
export class CompleteUploadUseCase {
  constructor(private readonly deps: FileDeps) {}

  /** Par le compte connecté, pour un fichier qu'il a déclaré. */
  async byOwner(fileId: string): Promise<StoredFile> {
    const user = requireUser();
    const file = await this.deps.files.findById(requireUuid('fileId', fileId));
    if (!file || !isOwnedBy(file, user.userId)) throw FileErrors.notFound();
    return this.complete(file);
  }

  /** Par un service, pour un fichier de ses finalités. */
  async byService(fileId: string): Promise<StoredFile> {
    const scope = requireServiceScope();
    const file = await this.deps.files.findById(requireUuid('fileId', fileId));
    if (!file || file.status === 'deleted' || !scope.purposes.includes(file.purpose)) {
      throw FileErrors.notFound();
    }
    return this.complete(file);
  }

  private async complete(file: StoredFile, attempt = 0): Promise<StoredFile> {
    if (file.status === 'available') return file;
    if (file.status === 'rejected') throw FileErrors.uploadRejected(file.rejectionReason ?? 'type_mismatch');
    if (file.status === 'deleted') throw FileErrors.notFound();

    const { storage, scanner, files, clock, settings } = this.deps;
    const stat = await storage.stat(file.storageKey);
    if (!stat) throw FileErrors.notUploaded();
    const head =
      stat.sizeBytes > 0 ? await storage.readHead(file.storageKey, SIGNATURE_BYTES) : new Uint8Array();
    let problem: RejectionReason | null = contentProblem(file, { ...stat, head });
    if (!problem && (await scanner.scan(file)) === 'infected') problem = 'malware';

    const now = clock.now();
    const saved = problem
      ? await files.complete(file.id, {
          status: 'rejected',
          reason: problem,
          completedAt: now,
          // La ligne reste lisible (motif du rejet) jusqu'à la purge des envois non confirmés.
          eraseAfter: new Date(now.getTime() + settings.pendingTtlMinutes * MINUTE_MS),
        })
      : await files.complete(file.id, { status: 'available', completedAt: now });
    if (!saved) {
      // Confirmation simultanée : l'état enregistré fait foi.
      const reloaded = await files.findById(file.id);
      if (!reloaded || attempt > 0) throw FileErrors.notFound();
      return this.complete(reloaded, attempt + 1);
    }
    if (problem) {
      // Un contenu refusé n'est jamais lisible : effacé tout de suite (au mieux, la purge repasse).
      await storage.remove(file.storageKey).catch(() => undefined);
      throw FileErrors.uploadRejected(problem);
    }
    return { ...file, status: 'available', completedAt: now };
  }
}
