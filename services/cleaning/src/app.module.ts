import { fileV1, geoV1, identityV1, walletV1 } from '@ksp/contracts';
import {
  GrpcCaller,
  grpcClientOptions,
  PlatformModule,
  SERVICE_TOKEN_PROVIDER,
  type ServiceTokenProvider,
} from '@ksp/platform';
import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { type ClientGrpc, ClientsModule } from '@nestjs/microservices';
import { CLEANING_DEPS, type CleaningDeps } from './application/deps';
import { type ServiceConfig } from './config';
import { GrpcPhotoStore } from './infrastructure/file/grpc-photo-store';
import { GeoServiceGeocoder } from './infrastructure/geocoding/geo-service.geocoder';
import { IdentityPeopleDirectory } from './infrastructure/identity/identity-people-directory';
import { OutboxRelayService } from './infrastructure/messaging/outbox-relay.service';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import { SystemClock, UuidV7Generator } from './infrastructure/system/system';
import { GrpcWalletLedger } from './infrastructure/wallet/grpc-wallet-ledger';
import { CLEANING_GRPC_CONTROLLERS } from './interfaces/grpc/controllers';

const IDENTITY_CLIENT = Symbol('IDENTITY_CLIENT');
const WALLET_CLIENT = Symbol('WALLET_CLIENT');
const GEO_CLIENT = Symbol('GEO_CLIENT');
const FILE_CLIENT = Symbol('FILE_CLIENT');

/**
 * Racine de composition : relie les ports à leurs adaptateurs. Le métier v2 (dépôts Prisma, cas
 * d'usage, consommateurs, tâches planifiées) s'y branche lot par lot (ADR-054).
 */
@Module({})
export class AppModule {
  static forRoot(config: ServiceConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        PlatformModule.forRoot(config),
        ClientsModule.register([
          grpcClientOptions(IDENTITY_CLIENT, 'identity', config.IDENTITY_GRPC_URL),
          grpcClientOptions(WALLET_CLIENT, 'wallet', config.WALLET_GRPC_URL),
          grpcClientOptions(FILE_CLIENT, 'file', config.FILE_GRPC_URL),
          grpcClientOptions(GEO_CLIENT, 'geo', config.GEO_GRPC_URL),
        ]),
      ],
      controllers: CLEANING_GRPC_CONTROLLERS,
      providers: [
        PrismaService,
        OutboxRelayService,
        {
          provide: CLEANING_DEPS,
          inject: [
            IDENTITY_CLIENT,
            WALLET_CLIENT,
            FILE_CLIENT,
            GEO_CLIENT,
            { token: SERVICE_TOKEN_PROVIDER, optional: true },
          ],
          useFactory: (
            identityGrpc: ClientGrpc,
            walletGrpc: ClientGrpc,
            fileGrpc: ClientGrpc,
            geoGrpc: ClientGrpc,
            serviceTokens: ServiceTokenProvider | undefined,
          ): CleaningDeps => {
            if (!serviceTokens) {
              new Logger('Cleaning').warn(
                'Aucun jeton de service : appels vers identity, wallet, file et geo non authentifiés (développement uniquement).',
              );
            }
            const caller = (target: string) =>
              new GrpcCaller({ target, ...(serviceTokens ? { serviceTokenProvider: serviceTokens } : {}) });
            return {
              people: new IdentityPeopleDirectory(
                identityGrpc.getService<identityV1.IdentityServiceClient>(identityV1.IDENTITY_SERVICE_NAME),
                caller('identity'),
              ),
              wallet: new GrpcWalletLedger(
                walletGrpc.getService<walletV1.WalletServiceClient>(walletV1.WALLET_SERVICE_NAME),
                caller('wallet'),
              ),
              photos: new GrpcPhotoStore(
                fileGrpc.getService<fileV1.FileInternalServiceClient>(fileV1.FILE_INTERNAL_SERVICE_NAME),
                caller('file'),
              ),
              // Délai de l'appel à geo : ses deux fournisseurs enchaînés, plus une marge d'une seconde.
              geocoder: new GeoServiceGeocoder(
                geoGrpc.getService<geoV1.GeoServiceClient>(geoV1.GEO_SERVICE_NAME),
                caller('geo'),
                2 * config.GEOCODING_TIMEOUT_MS + 1_000,
              ),
              clock: new SystemClock(),
              ids: new UuidV7Generator(),
            };
          },
        },
      ],
    };
  }
}
