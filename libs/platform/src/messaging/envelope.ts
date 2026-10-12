import { type EventEnvelope, type KspEventPayloads, type KspEventType } from '@ksp/contracts';
import { v7 as uuidv7 } from 'uuid';
import { currentContext, newCorrelationId } from '../context/request-context';

export interface CreateEnvelopeOptions {
  producer: string;
  version?: number;
  occurredAt?: Date;
}

/**
 * Crée l'enveloppe d'un événement déclaré dans @ksp/contracts.
 * Un événement absent des contrats ne compile pas : on ne publie jamais un événement non documenté.
 * La corrélation et la causalité viennent du contexte courant.
 */
export function createEnvelope<T extends KspEventType>(
  type: T,
  payload: KspEventPayloads[T],
  options: CreateEnvelopeOptions,
): EventEnvelope<T, KspEventPayloads[T]> {
  const context = currentContext();
  return {
    eventId: uuidv7(),
    type,
    version: options.version ?? 1,
    occurredAt: (options.occurredAt ?? new Date()).toISOString(),
    producer: options.producer,
    correlationId: context?.correlationId ?? newCorrelationId(),
    causationId: context?.causationId ?? null,
    payload,
  };
}
