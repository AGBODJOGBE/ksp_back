import { loadConfig } from '@ksp/platform';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { configSchema } from '../src/config';
import { __Name__GrpcController } from '../src/interfaces/grpc/__name__.controller';

describe('AppModule', () => {
  it('assemble toutes les dépendances du service', async () => {
    const config = loadConfig(configSchema, {
      SERVICE_NAME: '__name__',
      NODE_ENV: 'test',
      GRPC_PORT: '__GRPC_PORT__',
      HTTP_PORT: '__HTTP_PORT__',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      RABBITMQ_URL: 'amqp://localhost',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] }).compile();
    expect(moduleRef.get(__Name__GrpcController)).toBeDefined();
    await moduleRef.close();
  });
});
