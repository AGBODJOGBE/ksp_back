import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { SERVICE_TOKEN_VERIFIER, ServiceTokenVerifier } from '../auth/service-token';
import { SERVICE_TOKEN_PROVIDER, ServiceTokenClient } from '../auth/service-token-client';
import { type BaseServiceConfig } from '../config/config';
import { GrpcContextInterceptor } from '../grpc/grpc-context.interceptor';
import { HealthController } from '../health/health.controller';
import { ReadinessRegistry } from '../health/readiness';
import { createLoggerModule } from '../logging/logger';
import { RabbitMqConnection } from '../messaging/rabbitmq/connection';
import { RabbitMqConsumer } from '../messaging/rabbitmq/consumer';
import { RabbitMqPublisher } from '../messaging/rabbitmq/publisher';

export const SERVICE_CONFIG = Symbol('SERVICE_CONFIG');

/**
 * Module commun importé par chaque service :
 * journaux, santé et métriques, contexte des appels gRPC, vérification des jetons de service, RabbitMQ.
 */
@Global()
@Module({})
export class PlatformModule {
  static forRoot(config: BaseServiceConfig): DynamicModule {
    const providers: Provider[] = [
      { provide: SERVICE_CONFIG, useValue: config },
      ReadinessRegistry,
      GrpcContextInterceptor,
      { provide: RabbitMqConnection, useFactory: () => new RabbitMqConnection(config.RABBITMQ_URL) },
      {
        provide: RabbitMqPublisher,
        useFactory: (c: RabbitMqConnection) => new RabbitMqPublisher(c),
        inject: [RabbitMqConnection],
      },
      {
        provide: RabbitMqConsumer,
        useFactory: (c: RabbitMqConnection) => new RabbitMqConsumer(c, { consumer: config.SERVICE_NAME }),
        inject: [RabbitMqConnection],
      },
    ];
    if (config.IDENTITY_JWKS_URL) {
      providers.push({
        provide: SERVICE_TOKEN_VERIFIER,
        useValue: ServiceTokenVerifier.fromJwksUrl(
          config.IDENTITY_JWKS_URL,
          config.SERVICE_NAME,
          config.SERVICE_TOKEN_ISSUER,
        ),
      });
    }
    const tokenClient = Boolean(config.IDENTITY_TOKEN_URL && config.SERVICE_CLIENT_SECRET);
    if (tokenClient) {
      providers.push({
        provide: SERVICE_TOKEN_PROVIDER,
        useValue: new ServiceTokenClient({
          tokenUrl: config.IDENTITY_TOKEN_URL as string,
          clientId: config.SERVICE_NAME,
          clientSecret: config.SERVICE_CLIENT_SECRET as string,
        }),
      });
    }
    return {
      module: PlatformModule,
      imports: [createLoggerModule(config.SERVICE_NAME, config.LOG_LEVEL)],
      controllers: [HealthController],
      providers,
      exports: [
        SERVICE_CONFIG,
        ReadinessRegistry,
        GrpcContextInterceptor,
        RabbitMqConnection,
        RabbitMqPublisher,
        RabbitMqConsumer,
        ...(config.IDENTITY_JWKS_URL ? [SERVICE_TOKEN_VERIFIER] : []),
        ...(tokenClient ? [SERVICE_TOKEN_PROVIDER] : []),
      ],
    };
  }
}
