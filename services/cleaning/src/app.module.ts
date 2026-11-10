import { geoV1, identityV1, walletV1 } from '@ksp/contracts';
import {
  GrpcCaller,
  grpcClientOptions,
  PlatformModule,
  SERVICE_TOKEN_PROVIDER,
  type ServiceTokenProvider,
} from '@ksp/platform';
import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { type ClientGrpc, ClientsModule } from '@nestjs/microservices';
import { type ReverseGeocoder } from './application/ports';
import { CLEANING_USE_CASES, createUseCases } from './application/use-cases';
import { type ServiceConfig } from './config';
import { createGeocoder } from './infrastructure/geocoding/fallback.geocoder';
import { GeoServiceGeocoder } from './infrastructure/geocoding/geo-service.geocoder';
import { IdentityPeopleDirectory } from './infrastructure/identity/identity-people-directory';
import { GrpcWalletLedger } from './infrastructure/wallet/grpc-wallet-ledger';
import { BillingEventsConsumer } from './infrastructure/messaging/billing-events.consumer';
import { IdentityEventsConsumer } from './infrastructure/messaging/identity-events.consumer';
import { OutboxRelayService } from './infrastructure/messaging/outbox-relay.service';
import { PaymentEventsConsumer } from './infrastructure/messaging/payment-events.consumer';
import { PrismaAgentRepository } from './infrastructure/persistence/prisma-agent.repository';
import { PrismaCatalogRepository } from './infrastructure/persistence/prisma-catalog.repository';
import { PrismaContractInvoiceRepository } from './infrastructure/persistence/prisma-contract-invoice.repository';
import { PrismaMissionRepository } from './infrastructure/persistence/prisma-mission.repository';
import { PrismaOrganizationStandingRepository } from './infrastructure/persistence/prisma-organization-standing.repository';
import { PrismaQuoteRequestRepository } from './infrastructure/persistence/prisma-quote-request.repository';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import {
  PAYMENT_WATCH_INTERVAL_MS,
  PaymentWatchService,
} from './infrastructure/scheduling/payment-watch.service';
import {
  LOCATION_PURGE_INTERVAL_MS,
  LocationPurgeService,
} from './infrastructure/scheduling/location-purge.service';
import { SystemClock, UuidV7Generator } from './infrastructure/system/system';
import { CleaningAdminGrpcController } from './interfaces/grpc/admin.controller';
import {
  CatalogGrpcController,
  MissionGrpcController,
  MissionPaymentDueGrpcController,
  ObligationGrpcController,
  QuoteGrpcController,
} from './interfaces/grpc/customer.controllers';

const IDENTITY_CLIENT = Symbol('IDENTITY_CLIENT');
const WALLET_CLIENT = Symbol('WALLET_CLIENT');
const GEO_CLIENT = Symbol('GEO_CLIENT');

/**
 * Géocodage inverse (ADR-045) : le service geo si GEO_GRPC_URL est renseignée, sinon les
 * fournisseurs appelés directement (ADR-034), gardés en repli le temps du déploiement de geo.
 * Délai de l'appel à geo : ses deux fournisseurs enchaînés, plus une marge d'une seconde.
 */
function selectGeocoder(
  config: ServiceConfig,
  geoGrpc: ClientGrpc | undefined,
  serviceTokens: ServiceTokenProvider | undefined,
): ReverseGeocoder {
  const logger = new Logger('Cleaning');
  if (geoGrpc) {
    logger.log('Géocodage inverse : service geo.');
    return new GeoServiceGeocoder(
      geoGrpc.getService<geoV1.GeoServiceClient>(geoV1.GEO_SERVICE_NAME),
      new GrpcCaller({ target: 'geo', ...(serviceTokens ? { serviceTokenProvider: serviceTokens } : {}) }),
      2 * config.GEOCODING_TIMEOUT_MS + 1_000,
    );
  }
  const geocoder = createGeocoder(config);
  logger.log(
    geocoder.providerNames.length
      ? `Géocodage inverse : ${geocoder.providerNames.join(' puis ')} (appel direct, repli).`
      : 'Géocodage inverse désactivé (GEO_GRPC_URL, NOMINATIM_URL et GOOGLE_MAPS_API_KEY vides) : le client choisit sa commune.',
  );
  return geocoder;
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
          grpcClientOptions(IDENTITY_CLIENT, 'identity', config.IDENTITY_GRPC_URL),
          grpcClientOptions(WALLET_CLIENT, 'wallet', config.WALLET_GRPC_URL),
          ...(config.GEO_GRPC_URL ? [grpcClientOptions(GEO_CLIENT, 'geo', config.GEO_GRPC_URL)] : []),
        ]),
      ],
      controllers: [
        CatalogGrpcController,
        QuoteGrpcController,
        MissionGrpcController,
        CleaningAdminGrpcController,
        ObligationGrpcController,
        MissionPaymentDueGrpcController,
      ],
      providers: [
        PrismaService,
        OutboxRelayService,
        PrismaCatalogRepository,
        PrismaQuoteRequestRepository,
        PrismaMissionRepository,
        PrismaAgentRepository,
        PrismaContractInvoiceRepository,
        PrismaOrganizationStandingRepository,
        BillingEventsConsumer,
        IdentityEventsConsumer,
        PaymentEventsConsumer,
        PaymentWatchService,
        { provide: PAYMENT_WATCH_INTERVAL_MS, useValue: config.CLEANING_PAYMENT_WATCH_INTERVAL_MS },
        LocationPurgeService,
        { provide: LOCATION_PURGE_INTERVAL_MS, useValue: config.CLEANING_LOCATION_PURGE_INTERVAL_MS },
        {
          provide: CLEANING_USE_CASES,
          inject: [
            PrismaCatalogRepository,
            PrismaQuoteRequestRepository,
            PrismaMissionRepository,
            PrismaAgentRepository,
            PrismaContractInvoiceRepository,
            PrismaOrganizationStandingRepository,
            IDENTITY_CLIENT,
            WALLET_CLIENT,
            { token: SERVICE_TOKEN_PROVIDER, optional: true },
            { token: GEO_CLIENT, optional: true },
          ],
          useFactory: (
            catalog: PrismaCatalogRepository,
            requests: PrismaQuoteRequestRepository,
            missions: PrismaMissionRepository,
            agents: PrismaAgentRepository,
            invoices: PrismaContractInvoiceRepository,
            organizations: PrismaOrganizationStandingRepository,
            grpc: ClientGrpc,
            walletGrpc: ClientGrpc,
            serviceTokens: ServiceTokenProvider | undefined,
            geoGrpc: ClientGrpc | undefined,
          ) => {
            const geocoder = selectGeocoder(config, geoGrpc, serviceTokens);
            if (!serviceTokens) {
              new Logger('Cleaning').warn(
                'Aucun jeton de service : appels vers identity et wallet non authentifiés (développement uniquement).',
              );
            }
            return createUseCases({
              catalog,
              requests,
              missions,
              agents,
              invoices,
              organizations,
              people: new IdentityPeopleDirectory(
                grpc.getService<identityV1.IdentityServiceClient>(identityV1.IDENTITY_SERVICE_NAME),
                new GrpcCaller({
                  target: 'identity',
                  ...(serviceTokens ? { serviceTokenProvider: serviceTokens } : {}),
                }),
              ),
              wallet: new GrpcWalletLedger(
                walletGrpc.getService<walletV1.WalletServiceClient>(walletV1.WALLET_SERVICE_NAME),
                new GrpcCaller({
                  target: 'wallet',
                  ...(serviceTokens ? { serviceTokenProvider: serviceTokens } : {}),
                }),
              ),
              geocoder,
              fieldDates: {
                blockEarlyInterventionStart: config.CLEANING_BLOCK_EARLY_INTERVENTION_START,
                blockEarlyVisitReport: config.CLEANING_BLOCK_EARLY_VISIT_REPORT,
                timeZone: config.CLEANING_TIME_ZONE,
              },
              schedules: {
                maxMonths: config.CLEANING_SCHEDULE_MAX_MONTHS,
                maxVisits: config.CLEANING_SCHEDULE_MAX_VISITS,
                maxBatch: config.CLEANING_SCHEDULE_MAX_BATCH,
              },
              clock: new SystemClock(),
              ids: new UuidV7Generator(),
            });
          },
        },
      ],
    };
  }
}
