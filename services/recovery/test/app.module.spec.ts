import { loadConfig } from '@ksp/platform';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { configSchema } from '../src/config';
import { RecoveryGrpcController } from '../src/interfaces/grpc/recovery.controller';

describe('AppModule', () => {
  it('assemble toutes les dépendances du service', async () => {
    const config = loadConfig(configSchema, {
      SERVICE_NAME: 'recovery',
      NODE_ENV: 'test',
      GRPC_PORT: '50060',
      HTTP_PORT: '3110',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      RABBITMQ_URL: 'amqp://localhost',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] }).compile();
    expect(moduleRef.get(RecoveryGrpcController)).toBeDefined();
    await moduleRef.close();
  });
});
