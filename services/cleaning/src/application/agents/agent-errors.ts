import { AppError } from '@ksp/platform';

/**
 * Erreurs propres aux agents (piste A), en plus de celles de `shared/errors.ts`.
 *
 * Le contrat de cleaning n'a pas de code pour une panne d'identity ou de notification : le service
 * rend le code d'indisponibilité du kit (`<SERVICE>_UNAVAILABLE`, statut UNAVAILABLE, 503 à la
 * gateway), celui que le GrpcCaller produit quand son coupe-circuit est ouvert. L'appelant réessaie
 * avec la même clé d'idempotence.
 */
export const agentErrors = {
  dependencyUnavailable: (service: 'identity' | 'notification') =>
    AppError.unavailable(
      `${service.toUpperCase()}_UNAVAILABLE`,
      'Un service nécessaire est momentanément indisponible. Réessayez dans quelques instants.',
    ),
  /**
   * Validation d'un agent créé par l'admin dont le compte n'a jamais servi : identity refuse le rôle
   * à un compte en attente de vérification (IDENTITY_ACCOUNT_NOT_ACTIVE). Le code d'identity est
   * gardé ; le message dit à l'admin quoi faire.
   */
  accountNeverSignedIn: () =>
    AppError.precondition(
      'IDENTITY_ACCOUNT_NOT_ACTIVE',
      'Cet agent ne s’est encore jamais connecté à l’application agent. Il doit s’y connecter une fois ' +
        'avec son numéro de téléphone ; vous pourrez ensuite le valider.',
      { status: 'pending_verification', reason: 'agent_never_signed_in' },
    ),
  /**
   * Agent sans pièce d'identité enregistrée (jamais déposée, ou effacée). Le contrat ne prévoit que
   * CLEANING_AGENT_NOT_FOUND pour GetAgentIdDocument : la pièce demandée est introuvable.
   */
  idDocumentMissing: () =>
    AppError.notFound(
      'CLEANING_AGENT_NOT_FOUND',
      'Aucune pièce d’identité n’est enregistrée pour cet agent.',
      { reason: 'id_document_missing' },
    ),
};
