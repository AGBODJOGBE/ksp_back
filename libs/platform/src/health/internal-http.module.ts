import { type DynamicModule, Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ReadinessRegistry } from './readiness';
import { ShutdownState } from './shutdown';

/**
 * Serveur HTTP interne d'une application qui sert une API publique (la gateway, ADR-051) : sondes et
 * métriques sur un port séparé, jamais exposé, qui lit les vérifications de l'application principale.
 */
@Module({})
export class InternalHttpModule {
  static of(readiness: ReadinessRegistry, shutdown: ShutdownState): DynamicModule {
    return {
      module: InternalHttpModule,
      controllers: [HealthController],
      providers: [
        { provide: ReadinessRegistry, useValue: readiness },
        { provide: ShutdownState, useValue: shutdown },
      ],
    };
  }
}
