import { type Metadata } from '@grpc/grpc-js';
import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  type NestInterceptor,
  Optional,
} from '@nestjs/common';
import { defer, Observable, switchMap } from 'rxjs';
import { SERVICE_TOKEN_VERIFIER, type ServiceTokenVerifier } from '../auth/service-token';
import { contextFromMetadata, runWithContext } from '../context/request-context';

/**
 * Pour chaque appel gRPC entrant :
 * 1. vérifie le jeton de service de l'appelant (si un vérificateur est configuré, obligatoire en production) ;
 * 2. reconstruit le contexte (corrélation, utilisateur) depuis les métadonnées ;
 * 3. exécute le contrôleur dans ce contexte, pour que journaux, événements et appels sortants le portent.
 */
@Injectable()
export class GrpcContextInterceptor implements NestInterceptor {
  private readonly logger = new Logger(GrpcContextInterceptor.name);

  constructor(@Optional() @Inject(SERVICE_TOKEN_VERIFIER) private readonly verifier?: ServiceTokenVerifier) {
    if (!verifier) {
      this.logger.warn(
        'Aucun vérificateur de jeton de service : appels entre services non authentifiés (développement uniquement).',
      );
    }
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'rpc') return next.handle();
    const metadata = context.switchToRpc().getContext<Metadata>();
    return defer(async () => {
      const requestContext = contextFromMetadata(metadata);
      if (this.verifier) requestContext.callerService = await this.verifier.verify(metadata);
      return requestContext;
    }).pipe(
      switchMap(
        (requestContext) =>
          new Observable((subscriber) =>
            runWithContext(requestContext, () => next.handle().subscribe(subscriber)),
          ),
      ),
    );
  }
}
