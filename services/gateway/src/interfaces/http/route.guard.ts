import { AppError } from '@ksp/platform';
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthorizeRequestUseCase } from '../../application/access/authorize-request.use-case';
import { type RouteDefinition } from '../../domain/routing/route-manifest';
import { clientInfo, type GatewayRequest, header } from './http-types';

export const ROUTE_DEFINITION = 'ksp:gateway:route';

/**
 * Contrôles de la route avant le contrôleur : limite d'appels, type de client, jeton d'accès,
 * exigence d'accès, d'après sa ligne du manifeste de routage.
 */
@Injectable()
export class RouteGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorize: AuthorizeRequestUseCase,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const route = this.reflector.get<RouteDefinition | undefined>(ROUTE_DEFINITION, context.getHandler());
    if (!route) {
      throw new AppError('INTERNAL', 'GATEWAY_ROUTE_UNDECLARED', 'Route absente du manifeste de routage.');
    }
    const request = context.switchToHttp().getRequest<GatewayRequest>();
    const result = await this.authorize.execute(route, {
      ip: clientInfo(request).ip,
      authorization: header(request, 'authorization'),
      origin: header(request, 'origin'),
      appVersion: header(request, 'x-app-version'),
    });
    request.gateway = { route, ...result };
    return true;
  }
}
