import { recoveryV1 } from '@ksp/contracts';
import { Controller } from '@nestjs/common';

/**
 * Adaptateur gRPC : traduit chaque appel en cas d'usage (couche application).
 * Aucune règle métier ici.
 */
@Controller()
@recoveryV1.RecoveryServiceControllerMethods()
export class RecoveryGrpcController implements recoveryV1.RecoveryServiceController {}
