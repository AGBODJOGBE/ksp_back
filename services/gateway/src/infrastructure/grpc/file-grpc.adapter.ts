import { type Metadata } from '@grpc/grpc-js';
import { type fileV1 } from '@ksp/contracts';
import { AppError, type GrpcCaller } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { type Observable } from 'rxjs';
import { type Json } from '../../application/cleaning/cleaning.ports';
import { type FileApi, type FileUploadInput } from '../../application/file/file.ports';
import { toUpstreamError } from './upstream-error';

/** Réponse de file qui ne respecte pas le contrat : erreur interne, jamais transmise telle quelle. */
const malformed = (what: string) =>
  new AppError('INTERNAL', 'GATEWAY_UPSTREAM_ERROR', `Réponse de file inattendue (${what}).`);
const orNull = (value: string | undefined): string | null => (value ? value : null);
/** La confirmation relit le contenu dans le stockage (et passera par l'antivirus). */
const COMPLETE_DEADLINE_MS = 10_000;

/** Traduction d'un fichier ksp.file.v1 vers le JSON du contrat OpenAPI. */
export function presentFile(value: fileV1.StoredFile | undefined) {
  if (!value?.id) throw malformed('fichier');
  return {
    id: value.id,
    purpose: value.purpose,
    fileName: value.fileName,
    contentType: value.contentType,
    sizeBytes: Number(value.sizeBytes),
    status: value.status,
    rejectionReason: orNull(value.rejectionReason),
    subject: value.subject?.type ? { type: value.subject.type, id: value.subject.id } : null,
    createdAt: value.createdAt,
    completedAt: orNull(value.completedAt),
  };
}

function presentDownload(value: fileV1.DownloadUrl | undefined) {
  if (!value?.url) throw malformed('adresse de lecture');
  return { url: value.url, expiresAt: value.expiresAt };
}

/**
 * Client gRPC de file : délai, coupe-circuit et jeton de service par GrpcCaller. Seules les lectures
 * sont rejouées. Aucune adresse présignée n'est journalisée (ce sont des secrets de courte durée).
 */
export class FileGrpcAdapter implements FileApi {
  private readonly logger = new Logger('FileGrpc');

  constructor(
    private readonly client: fileV1.FileServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async createUpload(input: FileUploadInput): Promise<Json> {
    const res = await this.call('createUpload', (m) => this.client.createUpload(input, m), {});
    if (!res.upload?.url) throw malformed('adresse d’envoi');
    return {
      file: presentFile(res.file),
      upload: {
        url: res.upload.url,
        method: 'PUT',
        headers: res.upload.headers ?? {},
        expiresAt: res.upload.expiresAt,
      },
    };
  }

  async completeUpload(id: string): Promise<Json> {
    const res = await this.call('completeUpload', (m) => this.client.completeUpload({ fileId: id }, m), {
      deadlineMs: COMPLETE_DEADLINE_MS,
    });
    return presentFile(res.file);
  }

  async getMyFile(id: string): Promise<Json> {
    const res = await this.call('getMyFile', (m) => this.client.getMyFile({ fileId: id }, m), {
      idempotent: true,
    });
    return presentFile(res.file);
  }

  async createMyDownloadUrl(id: string): Promise<Json> {
    const res = await this.call(
      'createMyDownloadUrl',
      (m) => this.client.createMyDownloadUrl({ fileId: id }, m),
      { idempotent: true },
    );
    return presentDownload(res.download);
  }

  private async call<T>(
    name: string,
    invoke: (metadata: Metadata) => Observable<T>,
    options: { idempotent?: boolean; deadlineMs?: number },
  ): Promise<T> {
    try {
      return await this.caller.call(name, invoke, options);
    } catch (error) {
      const upstream = toUpstreamError('file', error);
      if (upstream.code !== (error as AppError)?.code) {
        this.logger.warn(`file.${name} : ${(error as AppError)?.code ?? 'erreur'} → ${upstream.code}`);
      }
      throw upstream;
    }
  }
}
