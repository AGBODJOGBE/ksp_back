import { PlatformModule } from '@ksp/platform';
import { type DynamicModule, Module } from '@nestjs/common';
import { type ServiceConfig } from './config';
import { OutboxRelayService } from './infrastructure/messaging/outbox-relay.service';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import { RecoveryGrpcController } from './interfaces/grpc/recovery.controller';

@Module({})
export class AppModule {
  static forRoot(config: ServiceConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [PlatformModule.forRoot(config)],
      controllers: [RecoveryGrpcController],
      providers: [PrismaService, OutboxRelayService],
    };
  }
}
