import { type RateLimitTable } from '../rate-limit/rate-limits';
import { type RouteDefinition } from './route-manifest';

/** Préfixes réservés par le contrat (x-ksp-reserved-prefixes) : aucune route au lot 1. */
export const RESERVED_PREFIXES = [
  '/api/v1/bff/web',
  '/api/v1/bff/mobile',
  '/api/v1/bff/admin',
  '/partner/v1',
];

/** Routes du back-office : double authentification toujours exigée (UC-GW-03). */
const BACKOFFICE_PREFIXES = ['/api/v1/admin/', '/api/v1/bff/admin/'];

/** Segments en minuscules ; paramètres entre accolades en camelCase ({id}, {fileId}). */
const PUBLIC_PATH =
  /^\/(api\/v1\/[a-z-]+\/([a-z0-9/-]|\{[a-z][A-Za-z]*\})*([a-z0-9]|\{[a-z][A-Za-z]*\})|\.well-known\/[a-z0-9.-]+)$/;

/** Permission : <service>.<ressource>.<action> (cleaning.request.process…). */
const PERMISSION = /^[a-z]+(\.[a-z_]+){2}$/;

/**
 * Règles du manifeste de routage (cahier des charges Gateway, partie 5) : chaque route déclare
 * son accès et sa limite, sans doublon, sous un préfixe autorisé ; une permission est la seule
 * condition d'accès de sa route (jamais avec des rôles) ; une route alias appelle la même méthode
 * gRPC qu'une route principale. Renvoie la liste des problèmes.
 */
export function manifestProblems(routes: readonly RouteDefinition[], limits: RateLimitTable): string[] {
  const problems: string[] = [];
  const operations = new Set<string>();
  const endpoints = new Set<string>();

  for (const route of routes) {
    const name = `${route.method} ${route.path}`;
    if (operations.has(route.operationId)) problems.push(`${route.operationId} : operationId en double`);
    operations.add(route.operationId);
    if (endpoints.has(name)) problems.push(`${name} : route en double`);
    endpoints.add(name);

    if (!PUBLIC_PATH.test(route.path)) problems.push(`${name} : chemin hors des préfixes autorisés`);
    if (RESERVED_PREFIXES.some((prefix) => route.path.startsWith(prefix))) {
      problems.push(`${name} : préfixe réservé`);
    }
    if (!/^[a-z0-9]+(\.[a-z0-9]+)*\.[A-Z]\w*\/[A-Z]\w*$/.test(route.grpc)) {
      problems.push(`${name} : appel gRPC mal formé (${route.grpc})`);
    }

    const rule = limits[route.rateLimit];
    if (!rule) problems.push(`${name} : catégorie de limite inconnue (${route.rateLimit})`);
    const connected = route.access.level === 'authenticated';
    if (rule?.key === 'user' && !connected) {
      problems.push(`${name} : limite par utilisateur sur une route non connectée`);
    }
    const { anyRole, permission, recentMfaSeconds } = route.access;
    if (!connected && (anyRole?.length || permission !== undefined || recentMfaSeconds !== undefined)) {
      problems.push(
        `${name} : rôles, permission ou double authentification exigés sur une route non connectée`,
      );
    }
    if (permission !== undefined && anyRole?.length) {
      problems.push(`${name} : permission et rôles exigés ensemble`);
    }
    if (permission !== undefined && !PERMISSION.test(permission)) {
      problems.push(`${name} : permission mal formée (${permission})`);
    }
    if (route.requiresCompleteProfile && !connected) {
      problems.push(`${name} : profil complet exigé sur une route non connectée`);
    }
    if (route.aliasOf !== undefined) {
      const principal = routes.find((other) => other.operationId === route.aliasOf);
      if (!principal || principal.aliasOf !== undefined || principal.grpc !== route.grpc) {
        problems.push(`${name} : alias sans route principale du même appel gRPC (${route.aliasOf})`);
      }
    }
    if (
      BACKOFFICE_PREFIXES.some((prefix) => route.path.startsWith(prefix)) &&
      route.access.recentMfaSeconds === undefined
    ) {
      problems.push(`${name} : route du back-office sans double authentification`);
    }
  }
  return problems;
}
