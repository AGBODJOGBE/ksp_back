/**
 * Types communs des vues de la gateway sur les services, indépendants de gRPC : chaque adaptateur
 * traduit les messages protobuf en JSON du contrat OpenAPI (montants { amount, currency }, chaînes
 * vides ↔ null). L'utilisateur voyage dans le contexte de la requête, jamais dans les paramètres.
 */
export type Json = Record<string, unknown>;

/** Page d'une liste paginée par curseur. */
export interface Page {
  limit?: number | undefined;
  cursor?: string | undefined;
}
