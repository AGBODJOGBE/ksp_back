import { loadConfig } from '@ksp/platform';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { configSchema } from '../src/config';
import { CleaningAdminGrpcController } from '../src/interfaces/grpc/admin.controller';
import {
  CatalogGrpcController,
  MissionGrpcController,
  ObligationGrpcController,
  QuoteGrpcController,
} from '../src/interfaces/grpc/customer.controllers';

describe('AppModule', () => {
  it('assemble toutes les dépendances du service', async () => {
    const config = loadConfig(configSchema, {
      SERVICE_NAME: 'cleaning',
      NODE_ENV: 'test',
      GRPC_PORT: '50053',
      HTTP_PORT: '3103',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      RABBITMQ_URL: 'amqp://localhost',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] }).compile();
    for (const controller of [
      CatalogGrpcController,
      QuoteGrpcController,
      MissionGrpcController,
      CleaningAdminGrpcController,
      ObligationGrpcController,
    ]) {
      expect(moduleRef.get(controller)).toBeDefined();
    }
    await moduleRef.close();
  });
});
