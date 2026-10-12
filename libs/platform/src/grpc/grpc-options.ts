import { type Server } from '@grpc/grpc-js';
import { GRPC_PACKAGES, type GrpcPackageName, PROTO_ROOT, protoPath } from '@ksp/contracts';
import { type ClientProviderOptions, type GrpcOptions, Transport } from '@nestjs/microservices';
import { HealthImplementation } from 'grpc-health-check';

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

export function grpcServerOptions(packages: GrpcPackageName[], port: number): GrpcOptions {
  return {
    transport: Transport.GRPC,
    options: {
      package: packages.map((name) => GRPC_PACKAGES[name].package),
      protoPath: packages.map((name) => protoPath(GRPC_PACKAGES[name].file)),
      url: `0.0.0.0:${port}`,
      loader: PROTO_LOADER_OPTIONS,
      onLoadPackageDefinition: (_definition: unknown, server: Pick<Server, 'addService'>) => {
        grpcHealth.addToServer(server as Server);
      },
    },
  };
}

/** Déclaration d'un client gRPC vers un autre service, à passer à ClientsModule.register. */
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
    },
  };
}
