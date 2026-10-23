import { AppError, currentContext } from '@ksp/platform';
import { type CleaningDeps } from '../deps';
import { requireUuid } from '../shared/validation';

export interface PendingObligation {
  kind: string;
  reference: string;
  description: string;
}

/** Seul identity interroge ce contrat, avant de supprimer un compte (UC-ID-11). */
const ALLOWED_CALLERS = new Set(['identity']);

/**
 * ksp.common.v1.ObligationService.HasPendingObligations : une mission non terminée
 * (à planifier, planifiée, en cours, en attente) bloque la suppression du compte.
 */
export class HasPendingObligationsUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { userId: string }): Promise<PendingObligation[]> {
    // Renseigné par le kit après vérification du jeton de service ; absent sans vérificateur (développement).
    const caller = currentContext()?.callerService;
    if (caller && !ALLOWED_CALLERS.has(caller)) {
      throw AppError.forbidden(
        'CLEANING_CALLER_FORBIDDEN',
        "Ce service n'est pas autorisé à appeler cette méthode.",
      );
    }
    const missions = await this.deps.missions.pendingForCustomer(requireUuid('userId', input.userId));
    return missions.map((mission) => ({
      kind: 'open_cleaning_mission',
      reference: mission.id,
      description: 'Une prestation de nettoyage est en cours ou à venir.',
    }));
  }
}
