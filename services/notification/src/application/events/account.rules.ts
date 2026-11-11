import { type IdentityEventType } from '@ksp/contracts';
import { type EventRule, type RuleContext } from './event-rules';
import { eventDate, eventDateTime } from './rule-dates';

/**
 * Messages de la suppression du compte publiés par identity (UC-ID-11, ADR-036), au titulaire du
 * compte : demande enregistrée, avec la date prévue, et annulation. identity.user.deleted n'a pas
 * de message : le compte anonymisé n'a plus de coordonnées. Réinitialisation de la double
 * authentification (ADR-050) : alerte au titulaire, avec l'échéance de la reconfiguration.
 *
 * Lien « Mon espace KSP » (chemin du portail à valider) : /mon-espace/compte.
 */

function accountLink(context: RuleContext): string {
  return `${context.portalBaseUrl}/mon-espace/compte`;
}

type AccountEventType = Extract<
  IdentityEventType,
  'identity.user.deletion_requested' | 'identity.user.deletion_cancelled' | 'identity.user.mfa_reset'
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

  // Double authentification réinitialisée au back-office (ADR-050) : alerte au titulaire, sans lien
  // (le back-office n'est pas dans « Mon espace KSP »).
  'identity.user.mfa_reset': (event, context) => [
    {
      userId: event.userId,
      templateCode: 'identity.mfa_reset.staff',
      variables: { enroll_before: eventDateTime(event.enrollBefore, context) },
      link: null,
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
