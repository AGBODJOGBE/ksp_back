import { PlatformModule } from '@ksp/platform';
import { type DynamicModule, Module } from '@nestjs/common';
import { type ServiceConfig } from './config';
import { OutboxRelayService } from './infrastructure/messaging/outbox-relay.service';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import {
  RecoveryAdminGrpcController,
  RecoveryCreditorGrpcController,
  RecoveryDebtorGrpcController,
  RecoveryPartnerGrpcController,
} from './interfaces/grpc/recovery.controller';

@Module({})
export class AppModule {
  static forRoot(config: ServiceConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [PlatformModule.forRoot(config)],
      controllers: [
        RecoveryCreditorGrpcController,
        RecoveryDebtorGrpcController,
        RecoveryPartnerGrpcController,
        RecoveryAdminGrpcController,
      ],
      providers: [PrismaService, OutboxRelayService],
    };
  }
}
