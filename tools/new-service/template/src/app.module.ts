import { PlatformModule } from '@ksp/platform';
import { type DynamicModule, Module } from '@nestjs/common';
import { type ServiceConfig } from './config';
import { OutboxRelayService } from './infrastructure/messaging/outbox-relay.service';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import { __Name__GrpcController } from './interfaces/grpc/__name__.controller';

@Module({})
export class AppModule {
  static forRoot(config: ServiceConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [PlatformModule.forRoot(config)],
      controllers: [__Name__GrpcController],
      providers: [PrismaService, OutboxRelayService],
    };
  }
}
