import { type CleaningDeps } from '../deps';
import { requireCaller } from '../shared/access';
import { requireUuid } from '../shared/validation';

export interface PendingObligation {
  kind: string;
  reference: string;
  description: string;
}

/** Seul identity interroge ce contrat, avant de supprimer un compte (UC-ID-11). */
const ALLOWED_CALLERS = ['identity'];

/**
 * ksp.common.v1.ObligationService.HasPendingObligations (UC-ID-11, ADR-036) : une mission non
 * terminée (à planifier, planifiée, en cours, en attente) ou une demande de devis ouverte (reçue,
 * visite planifiée, devis envoyé encore valide) bloque la suppression du compte. Toutes les
 * missions et demandes faites par le compte comptent, en son nom ou pour une organisation.
 */
export class HasPendingObligationsUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { userId: string }): Promise<PendingObligation[]> {
    requireCaller(ALLOWED_CALLERS);
    const customerId = requireUuid('userId', input.userId);
    const missions = await this.deps.missions.pendingForCustomer(customerId);
    const requests = await this.deps.requests.openForCustomer(customerId, this.deps.clock.now());
    return [
      ...missions.map((mission) => ({
        kind: 'open_cleaning_mission',
        reference: mission.id,
        description: 'Une prestation de nettoyage est en cours ou à venir.',
      })),
      ...requests.map((request) => ({
        kind: 'open_cleaning_request',
        reference: request.id,
        description: 'Une demande de devis de nettoyage est en cours.',
      })),
    ];
  }
}
