import { fileV1, identityV1, notificationV1 } from '@ksp/contracts';
import {
  GrpcCaller,
  grpcClientOptions,
  PlatformModule,
  SERVICE_TOKEN_PROVIDER,
  type ServiceTokenProvider,
} from '@ksp/platform';
import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { type ClientGrpc, ClientsModule } from '@nestjs/microservices';
import { type DocumentSettings } from './application/ports';
import { createUseCases, DOCUMENT_USE_CASES } from './application/use-cases';
import { codePolicyOf, genericTemplateEnabled, type ServiceConfig } from './config';
import { GrpcPdfStore } from './infrastructure/file/grpc-pdf-store';
import { GrpcUserDirectory } from './infrastructure/identity/grpc-user-directory';
import { OutboxRelayService } from './infrastructure/messaging/outbox-relay.service';
import { GrpcSignatureNotifier } from './infrastructure/notification/grpc-signature-notifier';
import { PdfKitRenderer } from './infrastructure/pdf/pdfkit-renderer';
import { PrismaDocumentRepository } from './infrastructure/persistence/prisma-document.repository';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import {
  EXPIRY_INTERVAL_MS,
  ExpireSignaturesService,
} from './infrastructure/scheduling/expire-signatures.service';
import { NodeSecretTools, SystemClock, UuidV7Generator } from './infrastructure/system/system';
import {
  DocumentGrpcController,
  DocumentInternalGrpcController,
  DocumentSigningGrpcController,
} from './interfaces/grpc/document.controllers';
import { AccountErasureConsumer } from './interfaces/messaging/account-erasure.consumer';

const FILE_CLIENT = Symbol('FILE_CLIENT');
const NOTIFICATION_CLIENT = Symbol('NOTIFICATION_CLIENT');
const IDENTITY_CLIENT = Symbol('IDENTITY_CLIENT');

export function settingsOf(config: ServiceConfig): DocumentSettings {
  return {
    issuer: {
      name: config.DOCUMENT_ISSUER_NAME,
      address: config.DOCUMENT_ISSUER_ADDRESS,
      legalDetails: config.DOCUMENT_ISSUER_LEGAL_DETAILS,
    },
    timeZone: config.DOCUMENT_TIME_ZONE,
    codePolicy: codePolicyOf(config),
    portalBaseUrl: config.PORTAL_BASE_URL.replace(/\/+$/, ''),
    genericTemplateEnabled: genericTemplateEnabled(config),
    internalCallers: config.DOCUMENT_INTERNAL_CALLERS,
  };
}

/** Racine de composition : relie les cas d'usage à leurs adaptateurs. */
@Module({})
export class AppModule {
  static forRoot(config: ServiceConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        PlatformModule.forRoot(config),
        ClientsModule.register([
          grpcClientOptions(FILE_CLIENT, 'file', config.FILE_GRPC_URL),
          grpcClientOptions(NOTIFICATION_CLIENT, 'notification', config.NOTIFICATION_GRPC_URL),
          grpcClientOptions(IDENTITY_CLIENT, 'identity', config.IDENTITY_GRPC_URL),
        ]),
      ],
      controllers: [DocumentInternalGrpcController, DocumentGrpcController, DocumentSigningGrpcController],
      providers: [
        PrismaService,
        OutboxRelayService,
        PrismaDocumentRepository,
        ExpireSignaturesService,
        { provide: EXPIRY_INTERVAL_MS, useValue: config.DOCUMENT_EXPIRY_INTERVAL_MS },
        AccountErasureConsumer,
        {
          provide: DOCUMENT_USE_CASES,
          inject: [
            PrismaDocumentRepository,
            FILE_CLIENT,
            NOTIFICATION_CLIENT,
            IDENTITY_CLIENT,
            { token: SERVICE_TOKEN_PROVIDER, optional: true },
          ],
          useFactory: (
            documents: PrismaDocumentRepository,
            file: ClientGrpc,
            notification: ClientGrpc,
            identity: ClientGrpc,
            serviceTokens: ServiceTokenProvider | undefined,
          ) => {
            if (!serviceTokens) {
              new Logger('Document').warn(
                'Aucun jeton de service : appels vers file, notification et identity non authentifiés (développement uniquement).',
              );
            }
            const tokens = serviceTokens ? { serviceTokenProvider: serviceTokens } : {};
            const settings = settingsOf(config);
            return createUseCases({
              documents,
              renderer: new PdfKitRenderer(settings.issuer),
              pdfs: new GrpcPdfStore(
                file.getService<fileV1.FileInternalServiceClient>(fileV1.FILE_INTERNAL_SERVICE_NAME),
                new GrpcCaller({ target: 'file', ...tokens }),
                { transferTimeoutMs: config.DOCUMENT_TRANSFER_TIMEOUT_MS },
              ),
              notifier: new GrpcSignatureNotifier(
                notification.getService<notificationV1.NotificationServiceClient>(
                  notificationV1.NOTIFICATION_SERVICE_NAME,
                ),
                new GrpcCaller({ target: 'notification', defaultDeadlineMs: 5000, ...tokens }),
              ),
              users: new GrpcUserDirectory(
                identity.getService<identityV1.IdentityServiceClient>(identityV1.IDENTITY_SERVICE_NAME),
                new GrpcCaller({ target: 'identity', ...tokens }),
              ),
              secrets: new NodeSecretTools(config.DOCUMENT_CODE_HMAC_SECRET),
              settings,
              clock: new SystemClock(),
              ids: new UuidV7Generator(),
            });
          },
        },
      ],
    };
  }
}
