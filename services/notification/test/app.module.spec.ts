import { loadConfig } from '@ksp/platform';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { SendNotificationUseCase } from '../src/application/send/send-notification.use-case';
import { configSchema } from '../src/config';
import { NotificationGrpcController } from '../src/interfaces/grpc/notification.controller';

const ENV = {
  SERVICE_NAME: 'notification',
  NODE_ENV: 'test',
  GRPC_PORT: '50052',
  HTTP_PORT: '3102',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  RABBITMQ_URL: 'amqp://localhost',
};

describe('AppModule', () => {
  it('assemble toutes les dépendances du service (prestataire console hors production)', async () => {
    const config = loadConfig(configSchema, ENV);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] }).compile();
    expect(moduleRef.get(NotificationGrpcController)).toBeDefined();
    expect(moduleRef.get(SendNotificationUseCase)).toBeDefined();
    await moduleRef.close();
  });

  it('assemble le service avec le prestataire meta', async () => {
    const config = loadConfig(configSchema, {
      ...ENV,
      NOTIFICATION_WHATSAPP_PROVIDER: 'meta',
      WHATSAPP_ACCESS_TOKEN: 'jeton',
      WHATSAPP_PHONE_NUMBER_ID: '106540352242922',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] }).compile();
    expect(moduleRef.get(SendNotificationUseCase)).toBeDefined();
    await moduleRef.close();
  });
});
