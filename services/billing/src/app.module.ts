import { PlatformModule } from '@ksp/platform';
import { type DynamicModule, Module } from '@nestjs/common';
import { BILLING_USE_CASES, createUseCases } from './application/use-cases';
import { type ServiceConfig } from './config';
import { CleaningEventsConsumer } from './infrastructure/messaging/cleaning-events.consumer';
import { OutboxRelayService } from './infrastructure/messaging/outbox-relay.service';
import { PrismaContractRepository } from './infrastructure/persistence/prisma-contract.repository';
import { PrismaInvoiceRepository } from './infrastructure/persistence/prisma-invoice.repository';
import { PrismaSettingsRepository } from './infrastructure/persistence/prisma-settings.repository';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import {
  BILLING_SCHEDULER_INTERVAL_MS,
  BillingSchedulerService,
} from './infrastructure/scheduling/billing-scheduler.service';
import { SystemClock, UuidV7Generator } from './infrastructure/system/system';
import { BillingAdminGrpcController, BillingGrpcController } from './interfaces/grpc/billing.controller';

/** Racine de composition : relie les cas d'usage à leurs adaptateurs. */
@Module({})
export class AppModule {
  static forRoot(config: ServiceConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [PlatformModule.forRoot(config)],
      controllers: [BillingGrpcController, BillingAdminGrpcController],
      providers: [
        PrismaService,
        OutboxRelayService,
        PrismaContractRepository,
        PrismaInvoiceRepository,
        PrismaSettingsRepository,
        CleaningEventsConsumer,
        BillingSchedulerService,
        { provide: BILLING_SCHEDULER_INTERVAL_MS, useValue: config.BILLING_SCHEDULER_INTERVAL_MS },
        {
          provide: BILLING_USE_CASES,
          inject: [PrismaContractRepository, PrismaInvoiceRepository, PrismaSettingsRepository],
          useFactory: (
            contracts: PrismaContractRepository,
            invoices: PrismaInvoiceRepository,
            settings: PrismaSettingsRepository,
          ) =>
            createUseCases({
              contracts,
              invoices,
              settings,
              clock: new SystemClock(),
              ids: new UuidV7Generator(),
            }),
        },
      ],
    };
  }
}
