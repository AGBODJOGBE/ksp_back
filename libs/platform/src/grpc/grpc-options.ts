import { type Server } from '@grpc/grpc-js';
import { GRPC_PACKAGES, type GrpcPackageName, PROTO_ROOT, protoPath } from '@ksp/contracts';
import { type ClientProviderOptions, type GrpcOptions, Transport } from '@nestjs/microservices';
import { HealthImplementation } from 'grpc-health-check';
import { deadlineInterceptor } from './deadline';

/**
 * Options de chargement des .proto, identiques côté serveur et côté client :
 * champs en camelCase, énumérations en texte, entiers 64 bits en nombres (montants en FCFA).
 */
export const PROTO_LOADER_OPTIONS = {
  keepCase: false,
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTO_ROOT],
};

/** Santé gRPC standard (grpc.health.v1), utilisée par les sondes k3s. */
export const grpcHealth = new HealthImplementation({ '': 'SERVING' });

/**
 * Connexions gRPC entre services (ADR-051). Les clients répartissent les appels entre toutes les
 * répliques (round_robin) : l'adresse d'un service en production est celle de son service headless,
 * résolue par le DNS en une adresse par réplique (dns:///identity-headless.ksp.svc.cluster.local:50051).
 * Le keepalive détecte une connexion morte (réplique disparue sans fermer) ; l'âge maximum des
 * connexions côté serveur force une nouvelle résolution, qui fait découvrir les nouvelles répliques.
 */
const CLIENT_KEEPALIVE = {
  keepaliveTimeMs: 30_000,
  keepaliveTimeoutMs: 10_000,
  keepalivePermitWithoutCalls: 1,
};
const ROUND_ROBIN = JSON.stringify({ loadBalancingConfig: [{ round_robin: {} }] });
const MAX_CONNECTION_AGE_MS = 5 * 60_000;
/** Délai laissé aux appels en cours sur une connexion arrivée à son âge maximum. */
const MAX_CONNECTION_AGE_GRACE_MS = 30_000;

export function grpcServerOptions(packages: GrpcPackageName[], port: number): GrpcOptions {
  return {
    transport: Transport.GRPC,
    options: {
      package: packages.map((name) => GRPC_PACKAGES[name].package),
      protoPath: packages.map((name) => protoPath(GRPC_PACKAGES[name].file)),
      url: `0.0.0.0:${port}`,
      loader: PROTO_LOADER_OPTIONS,
      channelOptions: {
        'grpc.max_connection_age_ms': MAX_CONNECTION_AGE_MS,
        'grpc.max_connection_age_grace_ms': MAX_CONNECTION_AGE_GRACE_MS,
      },
      // À l'arrêt, les appels en cours se terminent (tryShutdown) au lieu d'être coupés.
      gracefulShutdown: true,
      onLoadPackageDefinition: (_definition: unknown, server: Pick<Server, 'addService'>) => {
        grpcHealth.addToServer(server as Server);
      },
    },
  };
}

/**
 * Déclaration d'un client gRPC vers un autre service, à passer à ClientsModule.register.
 * `url` : localhost:50051 en développement, dns:///<service>-headless:<port> en production.
 */
export function grpcClientOptions(
  token: string | symbol,
  pkg: GrpcPackageName,
  url: string,
): ClientProviderOptions {
  return {
    name: token,
    transport: Transport.GRPC,
    options: {
      package: GRPC_PACKAGES[pkg].package,
      protoPath: protoPath(GRPC_PACKAGES[pkg].file),
      url,
      loader: PROTO_LOADER_OPTIONS,
      keepalive: CLIENT_KEEPALIVE,
      channelOptions: {
        'grpc.service_config': ROUND_ROBIN,
        // Transmet l'échéance de chaque appel au service appelé (ADR-051).
        interceptors: [deadlineInterceptor],
      },
    },
  };
}
