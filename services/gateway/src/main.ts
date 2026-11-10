import './tracing';
import 'reflect-metadata';
import { enableGracefulShutdown, loadConfig, ShutdownState } from '@ksp/platform';
import { NestFactory } from '@nestjs/core';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { collectDefaultMetrics } from 'prom-client';
import { AppModule } from './app.module';
import { configSchema } from './config';
import { configureHttpApp } from './interfaces/http/http-app';

/** Démarre la gateway : un seul serveur HTTP (API publique, santé, métriques), pas de gRPC entrant. */
async function main(): Promise<void> {
  const config = loadConfig(configSchema);
  collectDefaultMetrics({ labels: { service: config.SERVICE_NAME } });

  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    bufferLogs: true,
    bodyParser: false,
  });
  app.useLogger(app.get(Logger));
  configureHttpApp(app, config);
  const logger = app.get(Logger);
  // Arrêt en deux temps (ADR-051) : sonde « prêt » en 503, puis fermeture après le délai.
  enableGracefulShutdown(app, app.get(ShutdownState), { delayMs: config.SHUTDOWN_DELAY_MS, logger });

  await app.listen(config.HTTP_PORT, '0.0.0.0');
  logger.log(`${config.SERVICE_NAME} démarrée : HTTP :${config.HTTP_PORT}`);
}

void main();
