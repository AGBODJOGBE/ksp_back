import { loadConfig } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { configSchema } from '../src/config';
import { IdentityEventsConsumer } from '../src/infrastructure/messaging/identity-events.consumer';
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
      IdentityEventsConsumer,
    ]) {
      expect(moduleRef.get(controller)).toBeDefined();
    }
    await moduleRef.close();
  });

  it('GEO_GRPC_URL renseignée : géocodage inverse par le service geo (ADR-045)', async () => {
    const logs: string[] = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logs.push(String(message));
    });
    const config = loadConfig(configSchema, {
      SERVICE_NAME: 'cleaning',
      NODE_ENV: 'test',
      GRPC_PORT: '50053',
      HTTP_PORT: '3103',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      RABBITMQ_URL: 'amqp://localhost',
      GEO_GRPC_URL: 'localhost:50059',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] }).compile();
    expect(logs).toContain('Géocodage inverse : service geo.');
    await moduleRef.close();
    jest.restoreAllMocks();
  });
});
