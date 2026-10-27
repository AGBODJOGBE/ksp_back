import { type IdentityEventType } from '@ksp/contracts';
import { type EventRule, type NotificationIntent, type RuleContext } from './event-rules';

/**
 * Messages des comptes entreprise publiés par identity (ADR-027).
 *
 * Destinataires : l'équipe KSP qui valide les comptes entreprise
 * (NOTIFICATION_ACCOUNTS_TEAM_USER_IDS ; personne si la liste est vide) pour une nouvelle demande ;
 * le client qui a fait la demande (createdBy, administrateur de l'organisation) pour la validation,
 * le refus, la suspension (motif) et la réactivation. Une suspension ou une réactivation publiée
 * avant l'ajout de createdBy ne désigne personne : rien n'est envoyé.
 *
 * Lien « Mon espace KSP » (chemin du portail à valider) : /mon-espace/entreprise.
 */

function organizationsLink(context: RuleContext): string {
  return `${context.portalBaseUrl}/mon-espace/entreprise`;
}

function customer(
  userId: string,
  templateCode: string,
  link: string,
  variables: Record<string, string>,
): NotificationIntent {
  return { userId, templateCode, variables: { ...variables, link }, link };
}

type OrganizationEventType = Extract<
  IdentityEventType,
  | 'identity.organization.created'
  | 'identity.organization.validated'
  | 'identity.organization.rejected'
  | 'identity.organization.suspended'
  | 'identity.organization.reactivated'
>;

export const ORGANIZATION_RULES: { readonly [T in OrganizationEventType]: EventRule<T> } = {
  'identity.organization.created': (event, context) => {
    // Événement émis avant l'ajout de la raison sociale : rien à annoncer de lisible.
    if (!event.legalName) return [];
    const variables = { legal_name: event.legalName, organization_id: event.organizationId };
    return context.accountsTeamUserIds.map((userId) => ({
      userId,
      templateCode: 'identity.organization_requested.team',
      variables,
      link: null,
    }));
  },

  'identity.organization.validated': (event, context) => [
    customer(event.createdBy, 'identity.organization_validated.customer', organizationsLink(context), {
      legal_name: event.legalName,
    }),
  ],

  'identity.organization.rejected': (event, context) => [
    customer(event.createdBy, 'identity.organization_rejected.customer', organizationsLink(context), {
      legal_name: event.legalName,
      reason: event.reason,
    }),
  ],

  'identity.organization.suspended': (event, context) =>
    event.createdBy
      ? [
          customer(event.createdBy, 'identity.organization_suspended.customer', organizationsLink(context), {
            legal_name: event.legalName,
            reason: event.reason,
          }),
        ]
      : [],

  'identity.organization.reactivated': (event, context) =>
    event.createdBy
      ? [
          customer(
            event.createdBy,
            'identity.organization_reactivated.customer',
            organizationsLink(context),
            { legal_name: event.legalName },
          ),
        ]
      : [],
};
