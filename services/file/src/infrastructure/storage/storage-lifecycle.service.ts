import { ReadinessRegistry } from '@ksp/platform';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { S3ObjectStorage } from './s3-object-storage';

export const CREATE_BUCKET = Symbol('CREATE_BUCKET');

/**
 * Cycle de vie du stockage : sonde de disponibilité (`/health/ready`), création du bucket en
 * développement seulement (FILE_STORAGE_CREATE_BUCKET, refusé en production : le bucket et ses
 * règles CORS y sont créés par l'exploitation).
 */
@Injectable()
export class StorageLifecycleService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('FileStorage');

  constructor(
    private readonly storage: S3ObjectStorage,
    private readonly readiness: ReadinessRegistry,
    @Inject(CREATE_BUCKET) private readonly createBucket: boolean,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.readiness.register('storage', () => this.storage.ping());
    if (!this.createBucket) return;
    try {
      if ((await this.storage.ensureBucket()) === 'created') this.logger.log('Bucket de développement créé.');
    } catch {
      this.logger.warn('Stockage injoignable : bucket non vérifié (le service reste démarré).');
    }
  }

  onApplicationShutdown(): void {
    this.storage.destroy();
  }
}
