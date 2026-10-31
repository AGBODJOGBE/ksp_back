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
import { BILLING_USE_CASES, createUseCases } from './application/use-cases';
import { type ServiceConfig } from './config';
import { IdentityOrganizationDirectory } from './infrastructure/identity/identity-organization-directory';
import { CleaningEventsConsumer } from './infrastructure/messaging/cleaning-events.consumer';
import { OutboxRelayService } from './infrastructure/messaging/outbox-relay.service';
import { PaymentEventsConsumer } from './infrastructure/messaging/payment-events.consumer';
import { PrismaContractRepository } from './infrastructure/persistence/prisma-contract.repository';
import { PrismaInvoiceRepository } from './infrastructure/persistence/prisma-invoice.repository';
import { PrismaSettingsRepository } from './infrastructure/persistence/prisma-settings.repository';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import {
  BILLING_SCHEDULER_INTERVAL_MS,
  BillingSchedulerService,
} from './infrastructure/scheduling/billing-scheduler.service';
import { SystemClock, UuidV7Generator } from './infrastructure/system/system';
import {
  BillingAdminGrpcController,
  BillingGrpcController,
  InvoicePaymentDueGrpcController,
} from './interfaces/grpc/billing.controller';

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
      controllers: [BillingGrpcController, BillingAdminGrpcController, InvoicePaymentDueGrpcController],
      providers: [
        PrismaService,
        OutboxRelayService,
        PrismaContractRepository,
        PrismaInvoiceRepository,
        PrismaSettingsRepository,
        CleaningEventsConsumer,
        PaymentEventsConsumer,
        BillingSchedulerService,
        { provide: BILLING_SCHEDULER_INTERVAL_MS, useValue: config.BILLING_SCHEDULER_INTERVAL_MS },
        {
          provide: BILLING_USE_CASES,
          inject: [
            PrismaContractRepository,
            PrismaInvoiceRepository,
            PrismaSettingsRepository,
            IDENTITY_CLIENT,
            { token: SERVICE_TOKEN_PROVIDER, optional: true },
          ],
          useFactory: (
            contracts: PrismaContractRepository,
            invoices: PrismaInvoiceRepository,
            settings: PrismaSettingsRepository,
            grpc: ClientGrpc,
            serviceTokens: ServiceTokenProvider | undefined,
          ) => {
            if (!serviceTokens) {
              new Logger('Billing').warn(
                'Aucun jeton de service : appels vers identity non authentifiés (développement uniquement).',
              );
            }
            return createUseCases({
              contracts,
              invoices,
              settings,
              organizations: new IdentityOrganizationDirectory(
                grpc.getService<identityV1.IdentityServiceClient>(identityV1.IDENTITY_SERVICE_NAME),
                new GrpcCaller({
                  target: 'identity',
                  ...(serviceTokens ? { serviceTokenProvider: serviceTokens } : {}),
                }),
              ),
              clock: new SystemClock(),
              ids: new UuidV7Generator(),
            });
          },
        },
      ],
    };
  }
}
