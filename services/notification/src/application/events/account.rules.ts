import { type IdentityEventType } from '@ksp/contracts';
import { type EventRule, type RuleContext } from './event-rules';
import { eventDate } from './rule-dates';

/**
 * Messages de la suppression du compte publiés par identity (UC-ID-11, ADR-036), au titulaire du
 * compte : demande enregistrée, avec la date prévue, et annulation. identity.user.deleted n'a pas
 * de message : le compte anonymisé n'a plus de coordonnées.
 *
 * Lien « Mon espace KSP » (chemin du portail à valider) : /mon-espace/compte.
 */

function accountLink(context: RuleContext): string {
  return `${context.portalBaseUrl}/mon-espace/compte`;
}

type AccountEventType = Extract<
  IdentityEventType,
  'identity.user.deletion_requested' | 'identity.user.deletion_cancelled'
>;

export const ACCOUNT_RULES: { readonly [T in AccountEventType]: EventRule<T> } = {
  'identity.user.deletion_requested': (event, context) => [
    {
      userId: event.userId,
      templateCode: 'identity.account_deletion_requested.customer',
      variables: { scheduled_for: eventDate(event.scheduledFor, context), link: accountLink(context) },
      link: accountLink(context),
    },
  ],

  'identity.user.deletion_cancelled': (event, context) => [
    {
      userId: event.userId,
      templateCode: 'identity.account_deletion_cancelled.customer',
      variables: { link: accountLink(context) },
      link: accountLink(context),
    },
  ],
};
