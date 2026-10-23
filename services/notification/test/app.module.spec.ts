import { loadConfig } from '@ksp/platform';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { NotifyEventUseCase } from '../src/application/events/notify-event.use-case';
import { SendNotificationUseCase } from '../src/application/send/send-notification.use-case';
import { configSchema } from '../src/config';
import { NotificationGrpcController } from '../src/interfaces/grpc/notification.controller';
import { EventNotificationsConsumer } from '../src/interfaces/messaging/event-notifications.consumer';

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
    expect(moduleRef.get(NotifyEventUseCase)).toBeDefined();
    expect(moduleRef.get(EventNotificationsConsumer)).toBeDefined();
    await moduleRef.close();
  });

  it('assemble le service avec les prestataires meta et brevo, et le jeton de service', async () => {
    const config = loadConfig(configSchema, {
      ...ENV,
      NOTIFICATION_WHATSAPP_PROVIDER: 'meta',
      WHATSAPP_ACCESS_TOKEN: 'jeton',
      WHATSAPP_PHONE_NUMBER_ID: '106540352242922',
      NOTIFICATION_EMAIL_PROVIDER: 'brevo',
      BREVO_API_KEY: 'cle',
      EMAIL_SENDER_ADDRESS: 'notifications@ksp.bj',
      IDENTITY_TOKEN_URL: 'http://identity:3101/oauth/token',
      SERVICE_CLIENT_SECRET: 'secret',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] }).compile();
    expect(moduleRef.get(SendNotificationUseCase)).toBeDefined();
    await moduleRef.close();
  });
});
