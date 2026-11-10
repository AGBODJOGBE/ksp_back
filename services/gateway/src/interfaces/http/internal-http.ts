import { InternalHttpModule, ReadinessRegistry, ShutdownState } from '@ksp/platform';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

/**
 * Application du port interne de la gateway (ADR-051) : sondes de santé et métriques, à partir des
 * vérifications de l'application publique. Le port public ne sert que l'API.
 */
export async function createInternalHttpApp(app: INestApplication): Promise<INestApplication> {
  const internal = await NestFactory.create(
    InternalHttpModule.of(app.get(ReadinessRegistry), app.get(ShutdownState)),
    { logger: false },
  );
  await internal.init();
  return internal;
}
