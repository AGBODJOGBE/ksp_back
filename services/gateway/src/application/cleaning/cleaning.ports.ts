import { type CleaningOperationId } from '../../domain/routing/cleaning-routes';

/**
 * Vue de la gateway sur le service cleaning (v2, ADR-054), indépendante de gRPC : une route REST du
 * Nettoyage = un appel, décrit par le contrat. Les données arrivent validées contre le schéma de la
 * route ; l'adaptateur les place dans le message gRPC et traduit la réponse en JSON du contrat.
 * L'utilisateur voyage dans le contexte de la requête, jamais dans les paramètres.
 */
export interface CleaningCall {
  /** Paramètres de chemin, sous leur nom REST (`id`, `fileId`…). */
  params: Readonly<Record<string, unknown>>;
  /** Paramètres de requête déclarés, convertis (nombres, booléens). */
  query: Readonly<Record<string, unknown>>;
  /** Corps validé ; absent pour une route sans corps ou un corps facultatif non envoyé. */
  body?: Readonly<Record<string, unknown>> | undefined;
  /** En-tête Idempotency-Key, déjà contrôlé d'après le manifeste. */
  idempotencyKey?: string | undefined;
  /** Lecture : seule une lecture est rejouée après une panne (cahier des charges Gateway, partie 4). */
  read: boolean;
}

export interface CleaningApi {
  /** JSON de la réponse du contrat ; undefined pour une réponse sans corps (204). */
  call(operationId: CleaningOperationId, call: CleaningCall): Promise<unknown>;
}
