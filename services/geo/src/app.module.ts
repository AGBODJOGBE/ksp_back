import { PlatformModule } from '@ksp/platform';
import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { createUseCases, GEO_USE_CASES } from './application/use-cases';
import { type ServiceConfig } from './config';
import { CachedGeocoder } from './infrastructure/geocoding/cached.geocoder';
import { createGeocoder } from './infrastructure/geocoding/fallback.geocoder';
import { OsrmRoutingEngine } from './infrastructure/osrm/osrm.routing-engine';
import { GeoGrpcController } from './interfaces/grpc/geo.controller';

/**
 * Racine de composition. Sans base ni RabbitMQ : aucune sonde de disponibilité n'est inscrite, et
 * OSRM n'en est pas une (le géocodage reste servi quand le routage est indisponible).
 */
@Module({})
export class AppModule {
  static forRoot(config: ServiceConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [PlatformModule.forRoot(config)],
      controllers: [GeoGrpcController],
      providers: [
        {
          provide: GEO_USE_CASES,
          useFactory: () => {
            const logger = new Logger('Geo');
            const chain = createGeocoder(config);
            logger.log(
              chain.providerNames.length
                ? `Géocodage inverse : ${chain.providerNames.join(' puis ')}.`
                : 'Géocodage inverse désactivé (NOMINATIM_URL et GOOGLE_MAPS_API_KEY vides).',
            );
            if (!config.OSRM_URL) logger.warn('OSRM_URL vide : calcul d’itinéraire indisponible.');
            return createUseCases({
              geocoder: new CachedGeocoder(chain, {
                ttlMs: config.GEOCODING_CACHE_TTL_SECONDS * 1000,
                maxEntries: config.GEOCODING_CACHE_MAX_ENTRIES,
              }),
              routing: new OsrmRoutingEngine({ baseUrl: config.OSRM_URL, timeoutMs: config.OSRM_TIMEOUT_MS }),
            });
          },
        },
      ],
    };
  }
}
