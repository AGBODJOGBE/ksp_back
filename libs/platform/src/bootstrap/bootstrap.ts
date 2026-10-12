import 'reflect-metadata';
import { type GrpcPackageName } from '@ksp/contracts';
import { type INestApplication, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type MicroserviceOptions } from '@nestjs/microservices';
import { Logger } from 'nestjs-pino';
import { collectDefaultMetrics } from 'prom-client';
import { type BaseServiceConfig } from '../config/config';
import { GrpcExceptionFilter } from '../errors/grpc-exception.filter';
import { GrpcContextInterceptor } from '../grpc/grpc-context.interceptor';
import { grpcHealth, grpcServerOptions } from '../grpc/grpc-options';

export interface BootstrapOptions {
  module: Type<unknown>;
  config: BaseServiceConfig;
  /** Packages gRPC exposés par le service. */
  grpcPackages: GrpcPackageName[];
}

/**
 * Démarre un service : serveur gRPC (trafic métier) et serveur HTTP interne (santé, métriques).
 * Gère l'arrêt propre : le service se déclare indisponible avant de fermer ses connexions.
 */
export async function bootstrapService(options: BootstrapOptions): Promise<INestApplication> {
  const { module, config, grpcPackages } = options;
  collectDefaultMetrics({ labels: { service: config.SERVICE_NAME } });

  const app = await NestFactory.create(module, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.useGlobalFilters(new GrpcExceptionFilter());
  app.useGlobalInterceptors(app.get(GrpcContextInterceptor));
  app.enableShutdownHooks();

  app.connectMicroservice<MicroserviceOptions>(grpcServerOptions(grpcPackages, config.GRPC_PORT), {
    inheritAppConfig: true,
  });

  process.once('SIGTERM', () => grpcHealth.setStatus('', 'NOT_SERVING'));

  await app.startAllMicroservices();
  await app.listen(config.HTTP_PORT, '0.0.0.0');
  app
    .get(Logger)
    .log(`${config.SERVICE_NAME} démarré : gRPC :${config.GRPC_PORT}, HTTP :${config.HTTP_PORT}`);
  return app;
}
