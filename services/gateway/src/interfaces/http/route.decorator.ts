import {
  applyDecorators,
  HttpCode,
  RequestMapping,
  RequestMethod,
  SetMetadata,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { findRoute, type OperationId } from '../../domain/routing/route-manifest';
import { RequestContextInterceptor } from './request-context';
import { ROUTE_DEFINITION, RouteGuard } from './route.guard';

/** Chemin du contrat (`/missions/{id}`) au format d'Express (`/missions/:id`). */
export function expressPath(path: string): string {
  return path.replace(/\{([a-z]+)\}/gi, ':$1');
}

/**
 * Déclare un point d'entrée à partir du manifeste de routage : chemin et méthode viennent du
 * manifeste, jamais du contrôleur. Une route absente du manifeste ne peut donc pas être exposée.
 */
export function Route(operationId: OperationId): MethodDecorator {
  const route = findRoute(operationId);
  if (!route) throw new Error(`Route ${operationId} absente du manifeste de routage.`);
  return applyDecorators(
    RequestMapping({ path: expressPath(route.path), method: RequestMethod[route.method] }),
    HttpCode(200),
    SetMetadata(ROUTE_DEFINITION, route),
    UseGuards(RouteGuard),
    UseInterceptors(RequestContextInterceptor),
  );
}
