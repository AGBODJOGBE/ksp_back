import { type Metadata } from '@grpc/grpc-js';
import { AppError, type GrpcCaller } from '@ksp/platform';
import { type Observable } from 'rxjs';
import { agentErrors } from '../../application/agents/agent-errors';

/** Pannes du service appelé : injoignable, coupe-circuit ouvert, échéance dépassée. */
const OUTAGE_KINDS = ['UNAVAILABLE', 'DEADLINE_EXCEEDED'];

/**
 * Appel d'identity ou de notification dont l'issue décide d'une action du back-office (piste A),
 * par le GrpcCaller du kit : jeton de service, échéance, coupe-circuit, et une nouvelle tentative
 * pour un appel idempotent. Une panne devient `<SERVICE>_UNAVAILABLE` : l'action échoue et se rejoue
 * avec la même clé. Les refus du service appelé sont transmis tels quels.
 */
export async function callDependency<T>(
  service: 'identity' | 'notification',
  caller: GrpcCaller,
  name: string,
  invoke: (metadata: Metadata) => Observable<T>,
): Promise<T> {
  try {
    return await caller.call(name, invoke, { idempotent: true });
  } catch (error) {
    if (error instanceof AppError && OUTAGE_KINDS.includes(error.kind)) {
      throw agentErrors.dependencyUnavailable(service);
    }
    throw error;
  }
}
