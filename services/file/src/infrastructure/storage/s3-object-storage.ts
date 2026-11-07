import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { type ObjectStat, type ObjectStorage, type PresignedUpload } from '../../application/ports';
import { FileErrors } from '../../application/shared/errors';

export interface S3StorageOptions {
  /** Adresse du stockage vue par le service (réseau interne). */
  endpoint: string;
  /** Adresse vue par les clients, inscrite dans les adresses présignées ; par défaut `endpoint`. */
  publicEndpoint?: string | undefined;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Adressage par chemin (https://hôte/bucket/clé) : MinIO, et la plupart des stockages compatibles. */
  forcePathStyle: boolean;
}

const notFound = (error: unknown) => {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
};

/** En-tête Content-Disposition : nom ASCII de repli et nom UTF-8 (RFC 6266, RFC 5987). */
export function contentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Stockage objet compatible S3 (ADR-038) : MinIO en local, Object Storage de Contabo en production
 * (ADR-018). Le bucket est privé : tout accès d'un client passe par une adresse présignée.
 *
 * - Envoi : PUT présigné, `Content-Type` et `Content-Length` signés : le stockage refuse un autre
 *   type ou une autre taille que ceux déclarés.
 * - Sommes de contrôle calculées seulement quand l'API l'exige : les sommes ajoutées par défaut par
 *   les versions récentes du SDK ne sont pas reconnues par tous les stockages compatibles.
 * - Aucune erreur du SDK n'est transmise telle quelle (elle peut citer l'adresse appelée) :
 *   FILE_STORAGE_UNAVAILABLE.
 */
export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly signer: S3Client;

  constructor(private readonly options: S3StorageOptions) {
    const base: S3ClientConfig = {
      region: options.region,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      forcePathStyle: options.forcePathStyle,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 3,
    };
    this.client = new S3Client({ ...base, endpoint: options.endpoint });
    this.signer =
      options.publicEndpoint && options.publicEndpoint !== options.endpoint
        ? new S3Client({ ...base, endpoint: options.publicEndpoint })
        : this.client;
  }

  async presignUpload(
    key: string,
    input: { contentType: string; sizeBytes: number; expiresInSeconds: number },
  ): Promise<PresignedUpload> {
    const command = new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: key,
      ContentType: input.contentType,
      ContentLength: input.sizeBytes,
    });
    const url = await this.guard(() =>
      getSignedUrl(this.signer, command, {
        expiresIn: input.expiresInSeconds,
        signableHeaders: new Set(['content-type', 'content-length']),
      }),
    );
    return { url, headers: { 'Content-Type': input.contentType } };
  }

  presignDownload(
    key: string,
    input: { fileName: string; contentType: string; expiresInSeconds: number },
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.options.bucket,
      Key: key,
      ResponseContentType: input.contentType,
      ResponseContentDisposition: contentDisposition(input.fileName),
      ResponseCacheControl: `private, max-age=${input.expiresInSeconds}`,
    });
    return this.guard(() => getSignedUrl(this.signer, command, { expiresIn: input.expiresInSeconds }));
  }

  async stat(key: string): Promise<ObjectStat | null> {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }));
      return { sizeBytes: Number(head.ContentLength ?? 0), contentType: head.ContentType ?? null };
    } catch (error) {
      if (notFound(error)) return null;
      throw FileErrors.storageUnavailable();
    }
  }

  async readHead(key: string, bytes: number): Promise<Uint8Array> {
    return this.guard(async () => {
      const object = await this.client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: key, Range: `bytes=0-${bytes - 1}` }),
      );
      const body = object.Body ? await object.Body.transformToByteArray() : new Uint8Array();
      return body.slice(0, bytes);
    });
  }

  async remove(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
    } catch (error) {
      if (!notFound(error)) throw FileErrors.storageUnavailable();
    }
  }

  /** Sonde de disponibilité : le bucket répond. */
  async ping(): Promise<void> {
    await this.guard(() => this.client.send(new HeadBucketCommand({ Bucket: this.options.bucket })));
  }

  /** Développement : crée le bucket s'il n'existe pas (jamais en production). */
  async ensureBucket(): Promise<'exists' | 'created'> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.options.bucket }));
      return 'exists';
    } catch (error) {
      if (!notFound(error)) throw FileErrors.storageUnavailable();
    }
    await this.guard(() => this.client.send(new CreateBucketCommand({ Bucket: this.options.bucket })));
    return 'created';
  }

  destroy(): void {
    this.client.destroy();
    if (this.signer !== this.client) this.signer.destroy();
  }

  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      throw FileErrors.storageUnavailable();
    }
  }
}
