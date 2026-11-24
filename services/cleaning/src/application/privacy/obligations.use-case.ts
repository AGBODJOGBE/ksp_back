import { currentContext } from '@ksp/platform';
import { type PendingObligation, pendingObligations } from '../../domain/privacy/obligations';
import { type PrivacyDeps } from '../deps';
import { caseErrors } from '../requests/case-errors';
import { timelineOf } from '../requests/case-support';
import { type Owner } from '../requests/requests.ports';
import { requireUuid } from '../shared/input';

/** Seul identity interroge ce contrat, avant de supprimer un compte (obligation.proto, ADR-036). */
export const OBLIGATION_CALLER = 'identity';

/**
 * ksp.common.v1.ObligationService.HasPendingObligations (partie 3, ADR-036) : ce qui empêche la
 * suppression d'un compte. identity l'appelle à la demande de suppression, puis de nouveau juste
 * avant l'anonymisation ; une seule obligation bloque.
 * - Compte personnel : demande ouverte (statut effectif, RV-14), programme non terminé, séance à
 *   payer ou en retard, opération du wallet ou paiement direct en cours ; si le compte est un agent,
 *   affectation à venir (R-AG-03).
 * - Avec `organizationId` : les mêmes contrôles sur les dossiers de l'organisation, et ses factures
 *   mensuelles impayées suivies par cleaning (R-PE-06).
 * Lecture seule, sans effet de bord. Une lecture en échec remonte en erreur : identity refuse alors
 * la suppression (service injoignable), jamais « rien en cours » sans contrôle.
 */
export class HasPendingObligationsUseCase {
  constructor(private readonly deps: PrivacyDeps) {}

  async execute(input: { userId: string; organizationId?: string | null }): Promise<PendingObligation[]> {
    // Renseigné par le kit après vérification du jeton de service ; absent sans vérificateur
    // (développement local).
    const caller = currentContext()?.callerService;
    if (caller !== undefined && caller !== OBLIGATION_CALLER) throw caseErrors.callerForbidden();
    const userId = requireUuid(input.userId, 'userId');
    const organization = input.organizationId?.trim();
    const holder: Owner = organization
      ? { kind: 'organization', id: requireUuid(organization, 'organizationId') }
      : { kind: 'user', id: userId };
    const now = this.deps.clock.now();
    const [candidates, stored] = await Promise.all([
      this.deps.cases.openCandidates(holder),
      this.deps.personalData.storedObligations(holder, holder.kind === 'user' ? userId : null, now),
    ]);
    return pendingObligations(
      {
        ...stored,
        requests: candidates.map((record) => ({
          number: record.request.number,
          timeline: timelineOf(record),
        })),
      },
      now,
    );
  }
}
