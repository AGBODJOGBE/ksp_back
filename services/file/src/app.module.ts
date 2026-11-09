import { PlatformModule } from '@ksp/platform';
import { type DynamicModule, Module } from '@nestjs/common';
import { createUseCases, FILE_USE_CASES } from './application/use-cases';
import { dailyBytesPerOwner, type ServiceConfig } from './config';
import { OutboxRelayService } from './infrastructure/messaging/outbox-relay.service';
import { PrismaFileRepository } from './infrastructure/persistence/prisma-file.repository';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import { SkipMalwareScanner } from './infrastructure/scanning/skip-malware-scanner';
import { PURGE_INTERVAL_MS, PurgeFilesService } from './infrastructure/scheduling/purge-files.service';
import { S3ObjectStorage } from './infrastructure/storage/s3-object-storage';
import { CREATE_BUCKET, StorageLifecycleService } from './infrastructure/storage/storage-lifecycle.service';
import { SystemClock, UuidV7Generator } from './infrastructure/system/system';
import { FileGrpcController, FileInternalGrpcController } from './interfaces/grpc/file.controllers';
import { AccountErasureConsumer } from './interfaces/messaging/account-erasure.consumer';

/** Stockage objet du service, d'après la configuration (MinIO en local, Contabo en production). */
export function createStorage(config: ServiceConfig): S3ObjectStorage {
  return new S3ObjectStorage({
    endpoint: config.FILE_STORAGE_ENDPOINT,
    publicEndpoint: config.FILE_STORAGE_PUBLIC_ENDPOINT,
    region: config.FILE_STORAGE_REGION,
    bucket: config.FILE_STORAGE_BUCKET,
    accessKeyId: config.FILE_STORAGE_ACCESS_KEY,
    secretAccessKey: config.FILE_STORAGE_SECRET_KEY,
    forcePathStyle: config.FILE_STORAGE_FORCE_PATH_STYLE,
  });
}

/** Racine de composition : relie les cas d'usage à leurs adaptateurs. */
@Module({})
export class AppModule {
  static forRoot(config: ServiceConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [PlatformModule.forRoot(config)],
      controllers: [FileGrpcController, FileInternalGrpcController],
      providers: [
        PrismaService,
        OutboxRelayService,
        PrismaFileRepository,
        { provide: S3ObjectStorage, useFactory: () => createStorage(config) },
        { provide: CREATE_BUCKET, useValue: config.FILE_STORAGE_CREATE_BUCKET },
        StorageLifecycleService,
        PurgeFilesService,
        { provide: PURGE_INTERVAL_MS, useValue: config.FILE_PURGE_INTERVAL_MS },
        AccountErasureConsumer,
        {
          provide: FILE_USE_CASES,
          inject: [PrismaFileRepository, S3ObjectStorage],
          useFactory: (files: PrismaFileRepository, storage: S3ObjectStorage) =>
            createUseCases({
              files,
              storage,
              scanner: new SkipMalwareScanner(),
              clock: new SystemClock(),
              ids: new UuidV7Generator(),
              settings: {
                uploadUrlTtlSeconds: config.FILE_UPLOAD_URL_TTL_SECONDS,
                downloadUrlTtlSeconds: config.FILE_DOWNLOAD_URL_TTL_SECONDS,
                pendingTtlMinutes: config.FILE_PENDING_TTL_MINUTES,
                unattachedTtlHours: config.FILE_UNATTACHED_TTL_HOURS,
                eraseDelayHours: config.FILE_ERASE_DELAY_HOURS,
                maxPendingPerOwner: config.FILE_MAX_PENDING_PER_OWNER,
                dailyBytesPerOwner: dailyBytesPerOwner(config),
              },
            }),
        },
      ],
    };
  }
}
