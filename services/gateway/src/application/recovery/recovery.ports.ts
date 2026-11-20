import { type OperationId } from '../../domain/routing/route-manifest';
import { type Json } from '../cleaning/cleaning.ports';

/** Routes du recouvrement (ADR-060 à 062), désignées par leur operationId du contrat. */
export type RecoveryOperationId = Extract<OperationId, `recovery${string}`>;

/**
 * Demande validée par la gateway : paramètres du chemin et de la requête, corps, clé d'idempotence
 * et session du débiteur (ADR-061, secret jamais journalisé).
 */
export interface RecoveryRequest {
  params?: Record<string, string | number>;
  query?: Record<string, unknown>;
  body?: Json;
  idempotencyKey?: string;
  debtorSession?: string;
}

/**
 * Vue de la gateway sur le service recovery, indépendante de gRPC : un appel par route du contrat,
 * réponse au format du contrat OpenAPI.
 */
export interface RecoveryApi {
  call(operationId: RecoveryOperationId, request: RecoveryRequest): Promise<Json>;
}
