import { billingV1, fileV1, geoV1, identityV1, paymentV1, walletV1 } from '@ksp/contracts';
import {
  GrpcCaller,
  grpcClientOptions,
  PlatformModule,
  SERVICE_TOKEN_PROVIDER,
  type ServiceTokenProvider,
} from '@ksp/platform';
import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { type ClientGrpc, ClientsModule } from '@nestjs/microservices';
import { CATALOG_USE_CASES, catalogUseCases } from './application/catalog/catalog-use-cases';
import { CLEANING_DEPS, type CleaningDeps } from './application/deps';
import { type ServiceConfig } from './config';
import { AesGcmFieldCipher } from './infrastructure/crypto/aes-gcm-field-cipher';
import { GrpcPhotoStore } from './infrastructure/file/grpc-photo-store';
import { GeoServiceCommuneDirectory } from './infrastructure/geocoding/geo-service.communes';
import { GeoServiceGeocoder } from './infrastructure/geocoding/geo-service.geocoder';
import { GeoTravelTimes } from './infrastructure/geo/geo-travel-times';
import { IdentityPeopleDirectory } from './infrastructure/identity/identity-people-directory';
import { OutboxRelayService } from './infrastructure/messaging/outbox-relay.service';
import {
  PrismaCatalogSettingsReader,
  PrismaIdempotencyStore,
} from './infrastructure/persistence/catalog/prisma-catalog-settings';
import { PrismaCleaningTypeRepository } from './infrastructure/persistence/catalog/prisma-cleaning-type.repository';
import { PrismaHolidayRepository } from './infrastructure/persistence/catalog/prisma-holiday.repository';
import { PrismaOfferRepository } from './infrastructure/persistence/catalog/prisma-offer.repository';
import { PrismaParameterRepository } from './infrastructure/persistence/catalog/prisma-parameter.repository';
import { PrismaPlaceCatalogRepository } from './infrastructure/persistence/catalog/prisma-place-catalog.repository';
import { PrismaZoneRepository } from './infrastructure/persistence/catalog/prisma-zone.repository';
import { PrismaPlaceLocations } from './infrastructure/persistence/places/prisma-place-locations';
import { PrismaPlanningRepository } from './infrastructure/persistence/planning/prisma-planning.repository';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import { SystemClock, UuidV7Generator } from './infrastructure/system/system';
import { GrpcWalletLedger } from './infrastructure/wallet/grpc-wallet-ledger';
import { CLEANING_GRPC_CONTROLLERS } from './interfaces/grpc/controllers';
// Lot C
import { LOT_C_USE_CASES, lotCUseCases } from './application/requests/lot-c-use-cases';
import { GeoServiceCommuneResolver } from './infrastructure/geocoding/geo-service.commune-resolver';
import { MoneyEventsConsumer } from './infrastructure/messaging/money-events.consumer';
import { GrpcDirectPayments } from './infrastructure/payment/grpc-direct-payments';
import { PrismaCaseSettingsReader } from './infrastructure/persistence/requests/prisma-case-settings';
import { PrismaCaseRepository } from './infrastructure/persistence/requests/prisma-case.repository';
import { PrismaClientPlacesRepository } from './infrastructure/persistence/requests/prisma-client-places.repository';
import {
  CASE_DEADLINES_INTERVAL_MS,
  CaseDeadlinesService,
} from './infrastructure/scheduling/case-deadlines.service';
import { GrpcPrepaidBalances } from './infrastructure/wallet/grpc-prepaid-balances';
// Lot E
import {
  GrpcDirectPaymentGateway,
  GrpcInvoiceIssuer,
  GrpcWalletBalances,
} from './infrastructure/execution/grpc-execution-adapters';
import { WalletEventsConsumer } from './infrastructure/messaging/wallet-events.consumer';
import { PrismaExecutionRepository } from './infrastructure/persistence/execution/prisma-execution.repository';
import {
  EXECUTION_TASKS_INTERVAL_MS,
  ExecutionSchedulerService,
} from './infrastructure/scheduling/execution-scheduler.service';
// Lot G
import { PrismaAutoPlanningRepository } from './infrastructure/persistence/auto-planning/prisma-auto-planning.repository';
import { PrismaSettingsRepository } from './infrastructure/persistence/settings/prisma-settings.repository';
import { PrismaClaimRepository } from './infrastructure/persistence/claims/prisma-claim.repository';
import {
  AUTO_PLANNING_INTERVAL_MS,
  AutoPlanningScheduler,
} from './infrastructure/scheduling/auto-planning.scheduler';

const IDENTITY_CLIENT = Symbol('IDENTITY_CLIENT');
const WALLET_CLIENT = Symbol('WALLET_CLIENT');
const GEO_CLIENT = Symbol('GEO_CLIENT');
const FILE_CLIENT = Symbol('FILE_CLIENT');
// Lot E
const BILLING_CLIENT = Symbol('BILLING_CLIENT');
// Lots C et E
const PAYMENT_CLIENT = Symbol('PAYMENT_CLIENT');

/**
 * Racine de composition : relie les ports à leurs adaptateurs. Le métier v2 (dépôts Prisma, cas
 * d'usage, consommateurs, tâches planifiées) s'y branche lot par lot (ADR-054).
 */
@Module({})
export class AppModule {
  static forRoot(config: ServiceConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        PlatformModule.forRoot(config),
        ClientsModule.register([
          grpcClientOptions(IDENTITY_CLIENT, 'identity', config.IDENTITY_GRPC_URL),
          grpcClientOptions(WALLET_CLIENT, 'wallet', config.WALLET_GRPC_URL),
          grpcClientOptions(FILE_CLIENT, 'file', config.FILE_GRPC_URL),
          grpcClientOptions(GEO_CLIENT, 'geo', config.GEO_GRPC_URL),
          // Lot E
          grpcClientOptions(BILLING_CLIENT, 'billing', config.BILLING_GRPC_URL),
          // Lots C et E
          grpcClientOptions(PAYMENT_CLIENT, 'payment', config.PAYMENT_GRPC_URL),
        ]),
      ],
      controllers: CLEANING_GRPC_CONTROLLERS,
      providers: [
        PrismaService,
        OutboxRelayService,
        {
          provide: CLEANING_DEPS,
          inject: [
            PrismaService,
            IDENTITY_CLIENT,
            WALLET_CLIENT,
            FILE_CLIENT,
            GEO_CLIENT,
            { token: SERVICE_TOKEN_PROVIDER, optional: true },
            // Lot E
            BILLING_CLIENT,
            // Lots C et E
            PAYMENT_CLIENT,
          ],
          useFactory: (
            prisma: PrismaService,
            identityGrpc: ClientGrpc,
            walletGrpc: ClientGrpc,
            fileGrpc: ClientGrpc,
            geoGrpc: ClientGrpc,
            serviceTokens: ServiceTokenProvider | undefined,
            // Lot E
            billingGrpc: ClientGrpc,
            // Lots C et E
            paymentGrpc: ClientGrpc,
          ): CleaningDeps => {
            if (!serviceTokens) {
              new Logger('Cleaning').warn(
                'Aucun jeton de service : appels vers identity, wallet, file et geo non authentifiés (développement uniquement).',
              );
            }
            const caller = (target: string) =>
              new GrpcCaller({ target, ...(serviceTokens ? { serviceTokenProvider: serviceTokens } : {}) });
            const clock = new SystemClock();
            const ids = new UuidV7Generator();
            const geo = geoGrpc.getService<geoV1.GeoServiceClient>(geoV1.GEO_SERVICE_NAME);
            const cipher = AesGcmFieldCipher.fromConfig(
              config.CLEANING_FIELD_ENCRYPTION_KEY,
              config.NODE_ENV,
            );
            return {
              people: new IdentityPeopleDirectory(
                identityGrpc.getService<identityV1.IdentityServiceClient>(identityV1.IDENTITY_SERVICE_NAME),
                caller('identity'),
              ),
              wallet: new GrpcWalletLedger(
                walletGrpc.getService<walletV1.WalletServiceClient>(walletV1.WALLET_SERVICE_NAME),
                caller('wallet'),
              ),
              photos: new GrpcPhotoStore(
                fileGrpc.getService<fileV1.FileInternalServiceClient>(fileV1.FILE_INTERNAL_SERVICE_NAME),
                caller('file'),
              ),
              // Délai de l'appel à geo : ses deux fournisseurs enchaînés, plus une marge d'une seconde.
              geocoder: new GeoServiceGeocoder(geo, caller('geo'), 2 * config.GEOCODING_TIMEOUT_MS + 1_000),
              planning: new PrismaPlanningRepository(prisma, clock, ids),
              travel: new GeoTravelTimes(
                new PrismaPlaceLocations(prisma, cipher),
                geo,
                caller('geo'),
                config.TRAVEL_TIME_TIMEOUT_MS,
              ),
              cipher,
              clock,
              ids,
              places: new PrismaPlaceCatalogRepository(prisma, ids),
              parameters: new PrismaParameterRepository(prisma, ids),
              cleaningTypes: new PrismaCleaningTypeRepository(prisma, ids),
              offers: new PrismaOfferRepository(prisma, ids),
              zones: new PrismaZoneRepository(prisma, ids),
              holidays: new PrismaHolidayRepository(prisma, ids),
              settings: new PrismaCatalogSettingsReader(prisma),
              communes: new GeoServiceCommuneDirectory(geo, caller('geo')),
              idempotency: new PrismaIdempotencyStore(prisma),
              // --- Lot C : dossier, lieux du client, argent des frais de visite ---
              cases: new PrismaCaseRepository(prisma, ids),
              clientPlaces: new PrismaClientPlacesRepository(prisma, ids),
              caseSettings: new PrismaCaseSettingsReader(prisma),
              communeResolver: new GeoServiceCommuneResolver(geo, caller('geo')),
              balances: new GrpcPrepaidBalances(
                walletGrpc.getService<walletV1.WalletServiceClient>(walletV1.WALLET_SERVICE_NAME),
                caller('wallet'),
              ),
              // Lot E
              execution: new PrismaExecutionRepository(prisma, clock, ids),
              walletBalances: new GrpcWalletBalances(
                walletGrpc.getService<walletV1.WalletServiceClient>(walletV1.WALLET_SERVICE_NAME),
                caller('wallet'),
              ),
              invoices: new GrpcInvoiceIssuer(
                billingGrpc.getService<billingV1.InvoiceIssuanceServiceClient>(
                  billingV1.INVOICE_ISSUANCE_SERVICE_NAME,
                ),
                caller('billing'),
              ),
              sessionPayments: new GrpcDirectPaymentGateway(
                paymentGrpc.getService<paymentV1.TopUpPaymentServiceClient>(
                  paymentV1.TOP_UP_PAYMENT_SERVICE_NAME,
                ),
                caller('payment'),
              ),
              // Lot C : paiement direct des frais de visite.
              directPayments: new GrpcDirectPayments(
                paymentGrpc.getService<paymentV1.TopUpPaymentServiceClient>(
                  paymentV1.TOP_UP_PAYMENT_SERVICE_NAME,
                ),
                caller('payment'),
              ),
              placePoints: new PrismaPlaceLocations(prisma, cipher),
              // --- Lot G ---------------------------------------------------------------------
              autoPlanning: new PrismaAutoPlanningRepository(prisma, clock, ids),
              moduleSettings: new PrismaSettingsRepository(prisma, ids),
              claims: new PrismaClaimRepository(prisma, ids),
            };
          },
        },
        { provide: CATALOG_USE_CASES, inject: [CLEANING_DEPS], useFactory: catalogUseCases },
        // --- Lot C : cas d'usage, tâche des échéances, événements d'argent ---
        { provide: LOT_C_USE_CASES, inject: [CLEANING_DEPS], useFactory: lotCUseCases },
        CaseDeadlinesService,
        { provide: CASE_DEADLINES_INTERVAL_MS, useValue: config.CLEANING_DEADLINES_INTERVAL_MS },
        MoneyEventsConsumer,
        // Lot E
        WalletEventsConsumer,
        ExecutionSchedulerService,
        { provide: EXECUTION_TASKS_INTERVAL_MS, useValue: config.CLEANING_EXECUTION_TASKS_INTERVAL_MS },
        // --- Lot G : passage régulier de la planification automatique ------------------------
        { provide: AUTO_PLANNING_INTERVAL_MS, useValue: config.CLEANING_AUTO_PLANNING_INTERVAL_MS },
        AutoPlanningScheduler,
      ],
    };
  }
}
