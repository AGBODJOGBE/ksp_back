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
import { createInternalHttpApp } from './interfaces/http/internal-http';

/**
 * Démarre la gateway : l'API publique sur HTTP_PORT, santé et métriques sur INTERNAL_HTTP_PORT
 * (jamais exposé, ADR-051), pas de gRPC entrant.
 */
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
  const internal = await createInternalHttpApp(app);
  // Arrêt en deux temps (ADR-051) : sonde « prêt » en 503, puis fermeture après le délai ;
  // le port interne ferme en dernier, la sonde répond jusqu'au bout.
  const both = {
    close: async () => {
      await app.close();
      await internal.close();
    },
  };
  enableGracefulShutdown(both, app.get(ShutdownState), { delayMs: config.SHUTDOWN_DELAY_MS, logger });

  await app.listen(config.HTTP_PORT, '0.0.0.0');
  await internal.listen(config.INTERNAL_HTTP_PORT, '0.0.0.0');
  logger.log(
    `${config.SERVICE_NAME} démarrée : API :${config.HTTP_PORT}, santé et métriques :${config.INTERNAL_HTTP_PORT}`,
  );
}

void main();
