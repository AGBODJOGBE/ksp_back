import { commonV1 } from '@ksp/contracts';
import { Controller } from '@nestjs/common';
import { notImplemented } from './not-implemented';

/**
 * ksp.common.v1.ObligationService, appelé par identity avant la suppression d'un compte : une
 * demande ouverte, un programme non terminé ou une séance impayée la bloque (en-tête du proto).
 * Pas encore livré : identity lit la réponse NOT_IMPLEMENTED comme un service injoignable et
 * refuse la suppression (jamais de « rien en cours » sans contrôle).
 */
@Controller()
@commonV1.ObligationServiceControllerMethods()
export class ObligationGrpcController implements commonV1.ObligationServiceController {
  hasPendingObligations(): Promise<commonV1.HasPendingObligationsResponse> {
    return notImplemented('HasPendingObligations');
  }
}
