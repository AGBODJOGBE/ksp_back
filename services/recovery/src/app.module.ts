import { documentV1, fileV1, identityV1, notificationV1, paymentV1, walletV1 } from '@ksp/contracts';
import {
  BlindIndex,
  FieldCipher,
  GrpcCaller,
  grpcClientOptions,
  PlatformModule,
  SERVICE_TOKEN_PROVIDER,
  type ServiceTokenProvider,
} from '@ksp/platform';
import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { type ClientGrpc, ClientsModule } from '@nestjs/microservices';
import { type DebtorAccessPorts } from './application/debtor-access/debtor-access.ports';
import { type PersonalData } from './application/ports';
import { createUseCases, RECOVERY_USE_CASES } from './application/use-cases';
import { type ServiceConfig } from './config';
import { GrpcCreditorProfiles } from './infrastructure/grpc/grpc-creditor-profiles';
import { GrpcDocumentCancellation } from './infrastructure/grpc/grpc-document-cancellation';
import { PrismaAmicableStore } from './infrastructure/persistence/prisma-amicable.store';
import {
  AMICABLE_TASKS_INTERVAL_MS,
  AmicableTasksService,
} from './infrastructure/scheduling/amicable-tasks.service';
import { FileSpreadsheetReader } from './infrastructure/imports/file-spreadsheet-reader';
import { PrismaCaseImportRepository } from './infrastructure/persistence/prisma-case-imports.repository';
import { PrismaCaseQueries } from './infrastructure/persistence/prisma-case-queries';
import {
  CASE_PERSONAL_DATA,
  PrismaCaseRepository,
} from './infrastructure/persistence/prisma-cases.repository';
import { PrismaCreditorPreferencesStore } from './infrastructure/persistence/prisma-creditor-preferences.store';
import {
  CASE_DEADLINES_INTERVAL_MS,
  CaseDeadlinesService,
} from './infrastructure/scheduling/case-deadlines.service';
import { MandateSignatureConsumer } from './interfaces/messaging/mandate-signature.consumer';
// Argent et espace du débiteur (R3).
import { GrpcDebtorUploads, GrpcDocumentUrls } from './infrastructure/grpc/grpc-debtor-files';
import { PrismaMoneyStore } from './infrastructure/persistence/prisma-money.store';
import { MoneyEffectsService } from './infrastructure/scheduling/money-effects.service';
// Contentieux (R5).
import { PrismaLitigationStore } from './infrastructure/persistence/prisma-litigation.store';
import {
  LITIGATION_TASKS_INTERVAL_MS,
  LitigationTasksService,
} from './infrastructure/scheduling/litigation-tasks.service';
import { PaymentLinkPaidConsumer } from './interfaces/messaging/payment-link-paid.consumer';
import { GrpcDirectory } from './infrastructure/grpc/grpc-directory';
import { GrpcDocuments } from './infrastructure/grpc/grpc-documents';
import { GrpcFiles } from './infrastructure/grpc/grpc-files';
import { GrpcNotifier } from './infrastructure/grpc/grpc-notifier';
import { GrpcPaymentLinks } from './infrastructure/grpc/grpc-payment-links';
import { GrpcWalletGateway } from './infrastructure/grpc/grpc-wallet.gateway';
import { OutboxRelayService } from './infrastructure/messaging/outbox-relay.service';
import { PrismaDebtorAccessJournal } from './infrastructure/persistence/prisma-debtor-access.journal';
import {
  PrismaDebtorAccessStore,
  PrismaDebtorCaseReader,
} from './infrastructure/persistence/prisma-debtor-access.stores';
import { PrismaPricingRuleStore } from './infrastructure/persistence/prisma-pricing-rules.store';
import {
  PrismaAuditLog,
  PrismaCaseObligations,
  PrismaHolidayStore,
  PrismaSettingsStore,
} from './infrastructure/persistence/prisma-settings.stores';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import { KitPersonalData } from './infrastructure/security/kit-personal-data';
import { NodeDebtorSecrets } from './infrastructure/security/node-debtor-secrets';
import { SystemClock, UuidV7Generator } from './infrastructure/system/system';
import { ObligationGrpcController } from './interfaces/grpc/obligation.controller';
import {
  RecoveryAdminGrpcController,
  RecoveryCreditorGrpcController,
  RecoveryDebtorGrpcController,
  RecoveryPartnerGrpcController,
} from './interfaces/grpc/recovery.controller';

const WALLET_CLIENT = Symbol('WALLET_CLIENT');
const PAYMENT_CLIENT = Symbol('PAYMENT_CLIENT');
const DOCUMENT_CLIENT = Symbol('DOCUMENT_CLIENT');
const FILE_CLIENT = Symbol('FILE_CLIENT');
const NOTIFICATION_CLIENT = Symbol('NOTIFICATION_CLIENT');
const IDENTITY_CLIENT = Symbol('IDENTITY_CLIENT');
const DEBTOR_ACCESS = Symbol('DEBTOR_ACCESS');

/** Racine de composition : relie les cas d'usage à leurs adaptateurs (ADR-060). */
@Module({})
export class AppModule {
  static forRoot(config: ServiceConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        PlatformModule.forRoot(config),
        ClientsModule.register([
          grpcClientOptions(WALLET_CLIENT, 'wallet', config.WALLET_GRPC_URL),
          grpcClientOptions(PAYMENT_CLIENT, 'payment', config.PAYMENT_GRPC_URL),
          grpcClientOptions(DOCUMENT_CLIENT, 'document', config.DOCUMENT_GRPC_URL),
          grpcClientOptions(FILE_CLIENT, 'file', config.FILE_GRPC_URL),
          grpcClientOptions(NOTIFICATION_CLIENT, 'notification', config.NOTIFICATION_GRPC_URL),
          grpcClientOptions(IDENTITY_CLIENT, 'identity', config.IDENTITY_GRPC_URL),
        ]),
      ],
      controllers: [
        RecoveryCreditorGrpcController,
        RecoveryDebtorGrpcController,
        RecoveryPartnerGrpcController,
        RecoveryAdminGrpcController,
        ObligationGrpcController,
      ],
      providers: [
        PrismaService,
        OutboxRelayService,
        PrismaSettingsStore,
        PrismaHolidayStore,
        PrismaPricingRuleStore,
        PrismaAuditLog,
        PrismaCaseObligations,
        PrismaDebtorAccessStore,
        PrismaDebtorCaseReader,
        PrismaDebtorAccessJournal,
        {
          // Accès du débiteur sans compte (ADR-061) : lien, code, session et leur journal de preuve.
          provide: DEBTOR_ACCESS,
          inject: [PrismaDebtorAccessStore, PrismaDebtorCaseReader, PrismaDebtorAccessJournal],
          useFactory: (
            store: PrismaDebtorAccessStore,
            reader: PrismaDebtorCaseReader,
            journal: PrismaDebtorAccessJournal,
          ): DebtorAccessPorts => ({
            store,
            reader,
            journal,
            secrets: new NodeDebtorSecrets(config.RECOVERY_DEBTOR_CODE_HMAC_SECRET),
            baseUrl: config.RECOVERY_DEBTOR_BASE_URL,
          }),
        },
        // Dossiers (R2) : coordonnées chiffrées, dépôts, tâche des échéances, signatures du mandat.
        {
          provide: CASE_PERSONAL_DATA,
          useFactory: () =>
            new KitPersonalData(
              FieldCipher.fromConfig(
                config.RECOVERY_PII_ENCRYPTION_KEYS,
                config.NODE_ENV,
                'RECOVERY_PII_ENCRYPTION_KEYS',
              ),
              BlindIndex.fromConfig(
                config.RECOVERY_BLIND_INDEX_KEYS,
                config.NODE_ENV,
                'RECOVERY_BLIND_INDEX_KEYS',
              ),
            ),
        },
        PrismaCaseRepository,
        PrismaCaseQueries,
        PrismaCaseImportRepository,
        PrismaCreditorPreferencesStore,
        CaseDeadlinesService,
        { provide: CASE_DEADLINES_INTERVAL_MS, useValue: config.RECOVERY_CASE_DEADLINES_INTERVAL_MS },
        MandateSignatureConsumer,
        // Procédure amiable (R4) : contacts, échéanciers, décisions, messages, et sa tâche planifiée.
        PrismaAmicableStore,
        AmicableTasksService,
        { provide: AMICABLE_TASKS_INTERVAL_MS, useValue: config.RECOVERY_AMICABLE_INTERVAL_MS },
        // Argent et espace du débiteur (R3) : dépôt, liens payés, reprise des crédits et des clôtures.
        PrismaMoneyStore,
        PaymentLinkPaidConsumer,
        MoneyEffectsService,
        // Contentieux (R5) : courriers, devis et provisions, partenaires, et sa tâche planifiée.
        PrismaLitigationStore,
        LitigationTasksService,
        { provide: LITIGATION_TASKS_INTERVAL_MS, useValue: config.RECOVERY_LITIGATION_INTERVAL_MS },
        {
          provide: RECOVERY_USE_CASES,
          inject: [
            PrismaSettingsStore,
            PrismaHolidayStore,
            PrismaPricingRuleStore,
            PrismaAuditLog,
            PrismaCaseObligations,
            DEBTOR_ACCESS,
            CASE_PERSONAL_DATA,
            PrismaCaseRepository,
            PrismaCaseQueries,
            PrismaCaseImportRepository,
            PrismaCreditorPreferencesStore,
            PrismaAmicableStore,
            PrismaMoneyStore,
            PrismaLitigationStore,
            WALLET_CLIENT,
            PAYMENT_CLIENT,
            DOCUMENT_CLIENT,
            FILE_CLIENT,
            NOTIFICATION_CLIENT,
            IDENTITY_CLIENT,
            { token: SERVICE_TOKEN_PROVIDER, optional: true },
          ],
          useFactory: (
            settings: PrismaSettingsStore,
            holidays: PrismaHolidayStore,
            rules: PrismaPricingRuleStore,
            audit: PrismaAuditLog,
            obligations: PrismaCaseObligations,
            debtorAccess: DebtorAccessPorts,
            personalData: PersonalData,
            cases: PrismaCaseRepository,
            caseQueries: PrismaCaseQueries,
            imports: PrismaCaseImportRepository,
            preferences: PrismaCreditorPreferencesStore,
            amicable: PrismaAmicableStore,
            money: PrismaMoneyStore,
            litigation: PrismaLitigationStore,
            wallet: ClientGrpc,
            payment: ClientGrpc,
            document: ClientGrpc,
            file: ClientGrpc,
            notification: ClientGrpc,
            identity: ClientGrpc,
            serviceTokens: ServiceTokenProvider | undefined,
          ) => {
            if (!serviceTokens) {
              new Logger('Recovery').warn(
                'Aucun jeton de service : appels vers les autres services non authentifiés (développement uniquement).',
              );
            }
            const callerOf = (target: string) =>
              new GrpcCaller({
                target,
                defaultDeadlineMs: config.RECOVERY_GRPC_DEADLINE_MS,
                ...(serviceTokens ? { serviceTokenProvider: serviceTokens } : {}),
              });
            const identityClient = identity.getService<identityV1.IdentityServiceClient>(
              identityV1.IDENTITY_SERVICE_NAME,
            );
            const fileClient = file.getService<fileV1.FileInternalServiceClient>(
              fileV1.FILE_INTERNAL_SERVICE_NAME,
            );
            const documentClient = document.getService<documentV1.DocumentInternalServiceClient>(
              documentV1.DOCUMENT_INTERNAL_SERVICE_NAME,
            );
            return createUseCases({
              settings,
              holidays,
              rules,
              audit,
              obligations,
              personalData,
              cases,
              caseQueries,
              imports,
              preferences,
              creditorProfiles: new GrpcCreditorProfiles(identityClient, callerOf('identity')),
              spreadsheets: new FileSpreadsheetReader(fileClient, callerOf('file')),
              wallet: new GrpcWalletGateway(
                wallet.getService<walletV1.WalletServiceClient>(walletV1.WALLET_SERVICE_NAME),
                callerOf('wallet'),
              ),
              paymentLinks: new GrpcPaymentLinks(
                payment.getService<paymentV1.PaymentLinkServiceClient>(paymentV1.PAYMENT_LINK_SERVICE_NAME),
                callerOf('payment'),
              ),
              documents: new GrpcDocuments(
                documentClient,
                callerOf('document'),
                config.RECOVERY_LONG_DOCUMENT_DEADLINE_MS,
              ),
              files: new GrpcFiles(fileClient, callerOf('file')),
              notifier: new GrpcNotifier(
                notification.getService<notificationV1.NotificationServiceClient>(
                  notificationV1.NOTIFICATION_SERVICE_NAME,
                ),
                callerOf('notification'),
              ),
              directory: new GrpcDirectory(identityClient, callerOf('identity')),
              clock: new SystemClock(),
              ids: new UuidV7Generator(),
              debtorAccess,
              amicable,
              documentCancellation: new GrpcDocumentCancellation(documentClient, callerOf('document')),
              amicableOptions: { debtorChannels: config.RECOVERY_DEBTOR_CHANNELS },
              money,
              debtorUploads: new GrpcDebtorUploads(fileClient, callerOf('file')),
              documentUrls: new GrpcDocumentUrls(documentClient, callerOf('document')),
              litigation,
            });
          },
        },
      ],
    };
  }
}
