import { type fileV1 } from '@ksp/contracts';
import { type DownloadLink } from '../../application/access.use-cases';
import { type UploadTicket } from '../../application/uploads.use-cases';
import { type StoredFile } from '../../domain/stored-file';

const iso = (value: Date | null) => (value ? value.toISOString() : '');

/** Fichier ksp.file.v1 : jamais de clé de stockage, jamais de fichier supprimé. */
export function presentFile(file: StoredFile): fileV1.StoredFile {
  return {
    id: file.id,
    purpose: file.purpose,
    fileName: file.fileName,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    status: file.status,
    rejectionReason: file.rejectionReason ?? '',
    ownerId: file.ownerId ?? '',
    subject: file.subject ? { type: file.subject.type, id: file.subject.id } : undefined,
    createdAt: iso(file.createdAt),
    completedAt: iso(file.completedAt),
  };
}

export function presentDownload(link: DownloadLink): fileV1.DownloadUrl {
  return { url: link.url, expiresAt: link.expiresAt.toISOString() };
}

export function presentTicket(ticket: UploadTicket): {
  file: fileV1.StoredFile;
  upload: fileV1.UploadInstructions;
} {
  return {
    file: presentFile(ticket.file),
    upload: {
      url: ticket.upload.url,
      method: ticket.upload.method,
      headers: ticket.upload.headers,
      expiresAt: ticket.upload.expiresAt.toISOString(),
    },
  };
}
