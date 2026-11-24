import { Controller, Req } from '@nestjs/common';
import { CallCleaningUseCase } from '../../application/cleaning/call-cleaning.use-case';
import { CLEANING_ROUTES, type CleaningOperationId } from '../../domain/routing/cleaning-routes';
import { parseCleaningRequest, type RawCleaningRequest } from './cleaning-request';
import { type GatewayRequest, header } from './http-types';
import { Route } from './route.decorator';

type CleaningRequest = GatewayRequest & Partial<RawCleaningRequest>;

/**
 * Routes /api/v1/cleaning/* et /api/v1/admin/cleaning/* (Nettoyage v2, ADR-054) : un point d'entrée
 * par ligne du manifeste (cleaning-routes.ts, produit depuis le contrat), tous traités de la même
 * façon : validation des paramètres et du corps contre le schéma de la route, puis appel de cleaning.
 * Accès, permission, limite et clé d'idempotence sont contrôlés avant, par RouteGuard ; le service
 * revérifie toujours ses droits.
 */
@Controller()
export class CleaningHttpController {
  constructor(private readonly callCleaning: CallCleaningUseCase) {}

  /** Traitement commun ; les méthodes de route, posées ci-dessous, y délèguent. */
  forward(operationId: CleaningOperationId, request: CleaningRequest): Promise<unknown> {
    const input = parseCleaningRequest(operationId, {
      params: request.params ?? {},
      query: request.query ?? {},
      body: request.body,
    });
    const route = CLEANING_ROUTES.find((each) => each.operationId === operationId)!;
    return this.callCleaning.execute(route, {
      ...input,
      idempotencyKey: header(request, 'idempotency-key'),
      read: route.method === 'GET',
    });
  }
}

// Une méthode par route du manifeste, décorée comme une route écrite à la main (@Route, @Req) :
// chemin, méthode HTTP et contrôles viennent du manifeste, jamais du contrôleur.
for (const { operationId } of CLEANING_ROUTES) {
  const prototype = CleaningHttpController.prototype as unknown as Record<string, unknown>;
  Object.defineProperty(prototype, operationId, {
    value(this: CleaningHttpController, request: CleaningRequest) {
      return this.forward(operationId, request);
    },
    writable: true,
    configurable: true,
  });
  const descriptor = Object.getOwnPropertyDescriptor(prototype, operationId)!;
  Route(operationId)(prototype, operationId, descriptor);
  Req()(prototype, operationId, 0);
}
