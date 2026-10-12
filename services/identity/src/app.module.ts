import { PlatformModule } from '@ksp/platform';
import { type DynamicModule, Module } from '@nestjs/common';
import { type ServiceConfig } from './config';
import { OutboxRelayService } from './infrastructure/messaging/outbox-relay.service';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import { IdentityGrpcController } from './interfaces/grpc/identity.controller';

@Module({})
export class AppModule {
  static forRoot(config: ServiceConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [PlatformModule.forRoot(config)],
      controllers: [IdentityGrpcController],
      providers: [PrismaService, OutboxRelayService],
    };
  }
}
