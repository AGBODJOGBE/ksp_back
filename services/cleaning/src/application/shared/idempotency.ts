import { createHash } from 'node:crypto';
import { AppError } from '@ksp/platform';
import { ConcurrentUpdateError } from '../agents/agent.ports';
import {
  type IdempotencyKeyRef,
  type PlanningRepository,
  ScheduleOverlapError,
} from '../planning/planning.ports';
import { DuplicateKeyError, type IdempotencyRecord, type IdempotencyStore } from '../ports';
import { CleaningErrors, cleaningErrors, planningAppError } from './errors';

/**
 * Idempotence des créations et des validations (règle d'or n° 3, partie 15.3) : clé obligatoire,
 * 8 à 100 caractères. Premier appel : l'action s'exécute et enregistre sa clé, l'empreinte du corps
 * et sa réponse dans la même transaction. Rejeu (même compte, même opération, même clé) : même corps,
 * la réponse gardée est rejouée sans nouvel effet ; autre corps : CLEANING_IDEMPOTENCY_KEY_REUSED.
 * Deux appels simultanés : le second échoue sur la clé à l'écriture, puis rejoue la réponse du
 * premier.
 */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

/** Clé consommée par l'action, à poser dans ses changements (`Changes.idempotency`). */
export type IdempotencyStub = (response: Record<string, unknown>) => IdempotencyRecord;

/** Sérialisation stable : clés triées, pour une même empreinte quel que soit l'ordre des champs. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function requestHash(body: unknown): string {
  return createHash('sha256').update(canonical(body)).digest('hex');
}

export async function runIdempotent<T>(input: {
  store: IdempotencyStore;
  actorId: string;
  operation: string;
  key: string;
  /** Corps de la requête, sans la clé. */
  body: unknown;
  at: Date;
  run: (stub: IdempotencyStub) => Promise<T>;
  replay: (response: Record<string, unknown>) => Promise<T>;
}): Promise<T> {
  if (!IDEMPOTENCY_KEY.test(input.key)) throw CleaningErrors.validation('idempotencyKey', 'invalid_type');
  const ref = { actorId: input.actorId, operation: input.operation, key: input.key };
  const hash = requestHash(input.body);
  const replayIfSame = async (): Promise<T | null> => {
    const existing = await input.store.find(ref);
    if (!existing) return null;
    if (existing.requestHash !== hash) throw CleaningErrors.idempotencyKeyReused();
    return input.replay(existing.response);
  };
  const replayed = await replayIfSame();
  if (replayed !== null) return replayed;
  try {
    return await input.run((response) => ({ ...ref, requestHash: hash, response, at: input.at }));
  } catch (error) {
    if (!(error instanceof DuplicateKeyError) || error.key !== 'idempotency') throw error;
    const concurrent = await replayIfSame();
    if (concurrent === null) throw CleaningErrors.concurrentUpdate();
    return concurrent;
  }
}

// --- Agents et planification (lot D) ---------------------------------------------------------

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
