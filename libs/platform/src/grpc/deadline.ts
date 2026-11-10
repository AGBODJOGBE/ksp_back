import { AsyncLocalStorage } from 'node:async_hooks';
import { InterceptingCall, type Interceptor } from '@grpc/grpc-js';

const deadlines = new AsyncLocalStorage<Date>();

/**
 * Échéance du travail en cours : celle de l'appel gRPC reçu (propagée aux appels sortants), ou
 * celle de l'appel sortant en préparation. Aucune hors d'un appel gRPC (requête HTTP de la gateway).
 */
export function currentDeadline(): Date | undefined {
  return deadlines.getStore();
}

export function runWithDeadline<T>(deadline: Date | undefined, fn: () => T): T {
  return deadline ? deadlines.run(deadline, fn) : fn();
}

/** Échéance d'un appel reçu (Date, ou nombre de millisecondes ; Infinity : aucune). */
export function deadlineFrom(value: Date | number | undefined): Date | undefined {
  const time = value instanceof Date ? value.getTime() : value;
  return time !== undefined && Number.isFinite(time) ? new Date(time) : undefined;
}

/**
 * Intercepteur des clients gRPC : donne à l'appel l'échéance courante, que grpc-js transmet au
 * service appelé (en-tête grpc-timeout). Le service appelé arrête alors un travail que plus personne
 * n'attend, et propage la même échéance à ses propres appels (ADR-051).
 */
export const deadlineInterceptor: Interceptor = (options, nextCall) => {
  const deadline = currentDeadline();
  return new InterceptingCall(nextCall(deadline && !options.deadline ? { ...options, deadline } : options));
};
