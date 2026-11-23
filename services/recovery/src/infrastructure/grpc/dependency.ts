import { type Metadata } from '@grpc/grpc-js';
import { AppError, type GrpcCaller } from '@ksp/platform';
import { type Observable } from 'rxjs';
import { RecoveryErrors } from '../../application/shared/errors';

/**
 * Appel d'un service avec le GrpcCaller du kit (jeton de service, échéance, nouvelle tentative pour
 * un appel idempotent, coupe-circuit). Une panne (service injoignable, coupe-circuit ouvert, échéance
 * dépassée) devient RECOVERY_DEPENDENCY_UNAVAILABLE : l'appelant réessaie avec la même clé. Les
 * refus métier du service appelé (solde insuffisant, lien déjà payé…) sont transmis tels quels.
 */
export async function callDependency<T>(
  service: string,
  caller: GrpcCaller,
  name: string,
  invoke: (metadata: Metadata) => Promise<T> | Observable<T>,
  options: { idempotent?: boolean; deadlineMs?: number } = {},
): Promise<T> {
  try {
    return await caller.call(name, invoke, options);
  } catch (error) {
    if (error instanceof AppError && (error.kind === 'UNAVAILABLE' || error.kind === 'DEADLINE_EXCEEDED')) {
      throw RecoveryErrors.dependencyUnavailable(service);
    }
    throw error;
  }
}
