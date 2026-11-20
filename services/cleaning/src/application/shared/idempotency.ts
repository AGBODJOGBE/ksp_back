import { AppError } from '@ksp/platform';
import { ConcurrentUpdateError } from '../agents/agent.ports';
import {
  type IdempotencyKeyRef,
  type PlanningRepository,
  ScheduleOverlapError,
} from '../planning/planning.ports';
import { cleaningErrors, planningAppError } from './errors';

/**
 * Requête idempotente (partie 15.3) : la même clé rejouée avec le même contenu rend la réponse du
 * premier appel, sans refaire l'action ; avec un autre contenu, CLEANING_IDEMPOTENCY_KEY_REUSED. La
 * réponse est enregistrée dans la transaction de l'action (PlanningTx.remember).
 */
export async function replayed<T>(
  repository: Pick<PlanningRepository, 'idempotency'>,
  ref: IdempotencyKeyRef,
  requestHash: string,
): Promise<T | null> {
  const previous = await repository.idempotency(ref);
  if (!previous) return null;
  if (previous.requestHash !== requestHash) throw cleaningErrors.idempotencyKeyReused();
  return previous.response as T;
}

/** Erreurs d'écriture du dépôt → erreurs du contrat ; les autres passent telles quelles. */
export function writeError(error: unknown, agentIds: readonly string[] = []): unknown {
  if (error instanceof AppError) return error;
  if (error instanceof ScheduleOverlapError) {
    return planningAppError({ code: 'CLEANING_SCHEDULE_CONFLICT', details: { agentIds: [...agentIds] } });
  }
  if (error instanceof ConcurrentUpdateError) return cleaningErrors.concurrentUpdate();
  return error;
}
