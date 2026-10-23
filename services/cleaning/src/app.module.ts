import { PlatformModule } from '@ksp/platform';
import { type DynamicModule, Module } from '@nestjs/common';
import { CLEANING_USE_CASES, createUseCases } from './application/use-cases';
import { type ServiceConfig } from './config';
import { OutboxRelayService } from './infrastructure/messaging/outbox-relay.service';
import { PrismaAgentRepository } from './infrastructure/persistence/prisma-agent.repository';
import { PrismaCatalogRepository } from './infrastructure/persistence/prisma-catalog.repository';
import { PrismaMissionRepository } from './infrastructure/persistence/prisma-mission.repository';
import { PrismaQuoteRequestRepository } from './infrastructure/persistence/prisma-quote-request.repository';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import { SystemClock, UuidV7Generator } from './infrastructure/system/system';
import { CleaningAdminGrpcController } from './interfaces/grpc/admin.controller';
import {
  CatalogGrpcController,
  MissionGrpcController,
  ObligationGrpcController,
  QuoteGrpcController,
} from './interfaces/grpc/customer.controllers';

/** Racine de composition : relie les cas d'usage à leurs adaptateurs. */
@Module({})
export class AppModule {
  static forRoot(config: ServiceConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [PlatformModule.forRoot(config)],
      controllers: [
        CatalogGrpcController,
        QuoteGrpcController,
        MissionGrpcController,
        CleaningAdminGrpcController,
        ObligationGrpcController,
      ],
      providers: [
        PrismaService,
        OutboxRelayService,
        PrismaCatalogRepository,
        PrismaQuoteRequestRepository,
        PrismaMissionRepository,
        PrismaAgentRepository,
        {
          provide: CLEANING_USE_CASES,
          inject: [
            PrismaCatalogRepository,
            PrismaQuoteRequestRepository,
            PrismaMissionRepository,
            PrismaAgentRepository,
          ],
          useFactory: (
            catalog: PrismaCatalogRepository,
            requests: PrismaQuoteRequestRepository,
            missions: PrismaMissionRepository,
            agents: PrismaAgentRepository,
          ) =>
            createUseCases({
              catalog,
              requests,
              missions,
              agents,
              clock: new SystemClock(),
              ids: new UuidV7Generator(),
            }),
        },
      ],
    };
  }
}
