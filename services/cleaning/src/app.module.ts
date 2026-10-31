import { identityV1 } from '@ksp/contracts';
import {
  GrpcCaller,
  grpcClientOptions,
  PlatformModule,
  SERVICE_TOKEN_PROVIDER,
  type ServiceTokenProvider,
} from '@ksp/platform';
import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { type ClientGrpc, ClientsModule } from '@nestjs/microservices';
import { CLEANING_USE_CASES, createUseCases } from './application/use-cases';
import { type ServiceConfig } from './config';
import { IdentityPeopleDirectory } from './infrastructure/identity/identity-people-directory';
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

/** Racine de composition : relie les cas d'usage à leurs adaptateurs. */
@Module({})
export class AppModule {
  static forRoot(config: ServiceConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        PlatformModule.forRoot(config),
        ClientsModule.register([grpcClientOptions(IDENTITY_CLIENT, 'identity', config.IDENTITY_GRPC_URL)]),
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
            { token: SERVICE_TOKEN_PROVIDER, optional: true },
          ],
          useFactory: (
            catalog: PrismaCatalogRepository,
            requests: PrismaQuoteRequestRepository,
            missions: PrismaMissionRepository,
            agents: PrismaAgentRepository,
            invoices: PrismaContractInvoiceRepository,
            organizations: PrismaOrganizationStandingRepository,
            grpc: ClientGrpc,
            serviceTokens: ServiceTokenProvider | undefined,
          ) => {
            if (!serviceTokens) {
              new Logger('Cleaning').warn(
                'Aucun jeton de service : appels vers identity non authentifiés (développement uniquement).',
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
              fieldDates: {
                blockEarlyInterventionStart: config.CLEANING_BLOCK_EARLY_INTERVENTION_START,
                blockEarlyVisitReport: config.CLEANING_BLOCK_EARLY_VISIT_REPORT,
                timeZone: config.CLEANING_TIME_ZONE,
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
