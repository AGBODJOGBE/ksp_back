import { type PrivacyDeps } from '../deps';
import { type AccountErasure } from './privacy.ports';

/** Consommateur (inbox) de identity.user.deleted. */
export const ACCOUNT_DELETED_CONSUMER = 'cleaning.identity.user.deleted';

/**
 * Compte anonymisé par identity (identity.user.deleted, ADR-036) : règle R-DP-02, qui remplace
 * ADR-036 §9 pour le Nettoyage. Sont effacés, en une transaction avec la marque « événement
 * traité » :
 * - la position, le repère, l'adresse saisie et l'adresse lisible des lieux personnels du compte ;
 * - les copies de position de leurs demandes (R-DM-08) ;
 * - si le compte est un agent : ses positions d'arrivée (visites et séances), sa pièce d'identité,
 *   sa personne à prévenir et son numéro Mobile Money.
 * La commune et la distance d'arrivée sont gardées ; les lieux d'une organisation ne sont pas
 * touchés. Les fichiers (photos, pièce d'identité) sont effacés par file, qui écoute le même
 * événement : cleaning n'efface que ses propres lignes. Rejouer l'événement ne change rien.
 */
export class EraseAccountDataUseCase {
  constructor(private readonly deps: PrivacyDeps) {}

  execute(input: { eventId: string; userId: string }): Promise<AccountErasure> {
    return this.deps.personalData.eraseAccount(
      input.userId.toLowerCase(),
      { eventId: input.eventId, consumer: ACCOUNT_DELETED_CONSUMER },
      this.deps.clock.now(),
    );
  }
}
