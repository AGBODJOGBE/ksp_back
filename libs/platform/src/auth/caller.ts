import {
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
  UseInterceptors,
} from '@nestjs/common';
import { defer, type Observable } from 'rxjs';
import { currentContext } from '../context/request-context';
import { AppError } from '../errors/app-error';

/**
 * Exige que l'appel vienne de l'un des services autorisés, d'après le jeton de service vérifié par
 * le kit (ADR-022). Les métadonnées « utilisateur » (rôles, double authentification) ne sont pas
 * signées : seule la gateway, qui les tire d'un jeton d'accès vérifié, peut les transmettre aux
 * méthodes « utilisateur » et back-office (ADR-050). Sans vérificateur (développement local sans
 * jetons), l'appelant n'est pas connu et l'appel passe ; en production, le jeton est obligatoire.
 * Renvoie le service appelant, s'il est connu.
 */
export function requireCaller(allowed: readonly string[]): string | undefined {
  const caller = currentContext()?.callerService;
  if (caller !== undefined && !allowed.includes(caller)) {
    throw AppError.forbidden(
      'AUTH_CALLER_FORBIDDEN',
      "Ce service n'est pas autorisé à appeler cette méthode.",
      { caller },
    );
  }
  return caller;
}

/** Contrôle de l'appelant, exécuté dans le contexte posé par GrpcContextInterceptor (global). */
class AllowedCallersInterceptor implements NestInterceptor {
  constructor(private readonly allowed: readonly string[]) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return defer(() => {
      requireCaller(this.allowed);
      return next.handle();
    });
  }
}

const allowedByController = new WeakMap<object, readonly string[]>();

/**
 * Réserve toutes les méthodes d'un contrôleur gRPC aux services cités, par exemple
 * `@AllowedCallers('gateway')` sur les contrôleurs de l'espace connecté et du back-office.
 */
export function AllowedCallers(...services: string[]): ClassDecorator {
  const allowed = Object.freeze([...services]);
  return (target) => {
    allowedByController.set(target, allowed);
    UseInterceptors(new AllowedCallersInterceptor(allowed))(target);
  };
}

/** Services autorisés sur ce contrôleur ; undefined s'il n'est pas restreint (tests de câblage). */
export function allowedCallersOf(controller: object): readonly string[] | undefined {
  return allowedByController.get(controller);
}
