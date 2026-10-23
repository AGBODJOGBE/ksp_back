import { loadConfig } from '@ksp/platform';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { configSchema } from '../src/config';
import { BillingSchedulerService } from '../src/infrastructure/scheduling/billing-scheduler.service';
import { BillingAdminGrpcController, BillingGrpcController } from '../src/interfaces/grpc/billing.controller';

describe('AppModule', () => {
  it('assemble toutes les dépendances du service', async () => {
    const config = loadConfig(configSchema, {
      SERVICE_NAME: 'billing',
      NODE_ENV: 'test',
      GRPC_PORT: '50054',
      HTTP_PORT: '3104',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      RABBITMQ_URL: 'amqp://localhost',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] }).compile();
    expect(moduleRef.get(BillingGrpcController)).toBeDefined();
    expect(moduleRef.get(BillingAdminGrpcController)).toBeDefined();
    expect(moduleRef.get(BillingSchedulerService)).toBeDefined();
    await moduleRef.close();
  });
});
