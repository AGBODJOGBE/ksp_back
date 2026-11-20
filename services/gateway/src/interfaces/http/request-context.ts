import { newCorrelationId, type RequestContext, runWithContext, type UserContext } from '@ksp/platform';
import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { type AuthenticatedCaller } from '../../application/access/access.ports';
import { clientInfo, type GatewayRequest, type GatewayResponse, type Next } from './http-types';

export const CORRELATION_HEADER = 'X-Correlation-Id';

/**
 * Premier middleware : crée l'identifiant de corrélation de la requête (UC-GW-01) et le renvoie
 * dans l'en-tête X-Correlation-Id, y compris sur les erreurs. Une valeur envoyée par le client
 * n'est jamais reprise : l'identifiant sert à retrouver un parcours, il doit être unique.
 */
export function correlationMiddleware(request: GatewayRequest, response: GatewayResponse, next: Next): void {
  request.correlationId = newCorrelationId();
  response.setHeader(CORRELATION_HEADER, request.correlationId);
  next();
}

/**
 * Exécute le contrôleur dans le contexte de la requête (corrélation, client, utilisateur vérifié) :
 * GrpcCaller le transmet aux services dans les métadonnées gRPC, les journaux le portent.
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<GatewayRequest>();
    const requestContext: RequestContext = {
      correlationId: request.correlationId ?? newCorrelationId(),
      client: clientInfo(request),
    };
    const caller = request.gateway?.caller;
    if (caller) requestContext.user = userContextOf(caller);
    return new Observable((subscriber) =>
      runWithContext(requestContext, () => next.handle().subscribe(subscriber)),
    );
  }
}

/**
 * Utilisateur transmis aux services : celui du jeton vérifié, plus ses permissions (revendications
 * perms et zone_perms) quand il en porte. Le service revérifie chaque appel avec elles, sans appeler
 * identity (ADR-057, décision 4) ; sans permission, le contexte est celui d'avant leur ajout.
 */
export function userContextOf(caller: AuthenticatedCaller): UserContext {
  const { global, byZone } = caller.permissions;
  const zones = Object.entries(byZone).filter(([, permissions]) => permissions.length > 0);
  return {
    ...caller.user,
    ...(global.length ? { permissions: [...global] } : {}),
    ...(zones.length
      ? { zonePermissions: Object.fromEntries(zones.map(([zone, permissions]) => [zone, [...permissions]])) }
      : {}),
  };
}
