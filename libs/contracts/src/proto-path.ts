import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Racine des fichiers .proto.
 * - Paquet compilé : dist/proto (copié au build).
 * - Exécution depuis les sources (tests, développement) : contracts/proto à la racine du dépôt.
 */
function resolveProtoRoot(): string {
  const candidates = [join(__dirname, 'proto'), resolve(__dirname, '..', '..', '..', 'contracts', 'proto')];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`Fichiers .proto introuvables (cherchés dans : ${candidates.join(', ')})`);
  }
  return found;
}

export const PROTO_ROOT = resolveProtoRoot();

/** Chemin absolu d'un fichier .proto, par exemple protoPath('ksp/identity/v1/identity.proto'). */
export function protoPath(relativePath: string): string {
  return join(PROTO_ROOT, relativePath);
}

/** Packages gRPC connus, avec le fichier qui les déclare. */
export const GRPC_PACKAGES = {
  // new-service:packages (le générateur de service ajoute les nouveaux packages ici)
  identity: { package: 'ksp.identity.v1', file: 'ksp/identity/v1/identity.proto' },
  notification: { package: 'ksp.notification.v1', file: 'ksp/notification/v1/notification.proto' },
  obligation: { package: 'ksp.common.v1', file: 'ksp/common/v1/obligation.proto' },
} as const;

export type GrpcPackageName = keyof typeof GRPC_PACKAGES;
