import { type CleaningEventPayloads } from '@ksp/contracts';
import { type CleaningStaffPermission, type NotificationIntent, type RuleContext } from './event-rules';

/**
 * Destinataires, liens et libellés des messages du Nettoyage v2 (CDC Nettoyage v2, 16.2).
 *
 * Liens profonds (chemins des fronts à valider avec eux) :
 * - portail, « Mon espace KSP » (`PORTAL_BASE_URL`) :
 *   - demande : /mon-espace/nettoyage/demandes/<requestId> ;
 *   - programme : /mon-espace/nettoyage/programmes/<programId> ;
 *   - séance : /mon-espace/nettoyage/programmes/<programId>/seances/<sessionId> ;
 *   - commander à nouveau (R-PG-08) : /mon-espace/nettoyage/programmes/<programId>/commander-a-nouveau ;
 *   - réclamation : /mon-espace/nettoyage/reclamations/<claimId> ;
 *   - portefeuille : /mon-espace/portefeuille ; factures : /mon-espace/factures[/<invoiceId>] ;
 *   - dossier d'une organisation : `?organisation=<organizationId>`, comme les factures (le portail
 *     ouvre la page dans le contexte de l'organisation) ;
 * - back-office (`BACKOFFICE_BASE_URL`, facultatif ; absent : messages du personnel sans lien) :
 *   /nettoyage/demandes/<requestId>, /nettoyage/programmes/<programId>,
 *   /nettoyage/programmes/<programId>/seances/<sessionId>, /nettoyage/reclamations/<claimId>,
 *   /nettoyage/agents/<agentId>, /nettoyage/organisations/<organizationId> ;
 * - application agent : aucun lien (l'agent retrouve ses visites et séances dans l'application).
 */

type Owner = { customerId: string; organizationId: string | null };

function withOrganization(link: string, organizationId: string | null): string {
  return organizationId ? `${link}?organisation=${encodeURIComponent(organizationId)}` : link;
}

const id = encodeURIComponent;

/** Liens du portail, dans le contexte de l'organisation du dossier s'il y en a une. */
export const portal = {
  request: (context: RuleContext, event: { requestId: string; organizationId: string | null }) =>
    withOrganization(
      `${context.portalBaseUrl}/mon-espace/nettoyage/demandes/${id(event.requestId)}`,
      event.organizationId,
    ),
  program: (context: RuleContext, event: { programId: string; organizationId: string | null }) =>
    withOrganization(
      `${context.portalBaseUrl}/mon-espace/nettoyage/programmes/${id(event.programId)}`,
      event.organizationId,
    ),
  session: (
    context: RuleContext,
    event: { programId: string; sessionId: string; organizationId: string | null },
  ) =>
    withOrganization(
      `${context.portalBaseUrl}/mon-espace/nettoyage/programmes/${id(event.programId)}/seances/${id(event.sessionId)}`,
      event.organizationId,
    ),
  reorder: (context: RuleContext, event: { programId: string; organizationId: string | null }) =>
    withOrganization(
      `${context.portalBaseUrl}/mon-espace/nettoyage/programmes/${id(event.programId)}/commander-a-nouveau`,
      event.organizationId,
    ),
  claim: (context: RuleContext, event: { claimId: string; organizationId: string | null }) =>
    withOrganization(
      `${context.portalBaseUrl}/mon-espace/nettoyage/reclamations/${id(event.claimId)}`,
      event.organizationId,
    ),
  wallet: (context: RuleContext) => `${context.portalBaseUrl}/mon-espace/portefeuille`,
  invoice: (context: RuleContext, invoiceId: string, organizationId: string | null) =>
    withOrganization(`${context.portalBaseUrl}/mon-espace/factures/${id(invoiceId)}`, organizationId),
  invoices: (context: RuleContext, organizationId: string | null) =>
    withOrganization(`${context.portalBaseUrl}/mon-espace/factures`, organizationId),
};

/** Chemin du back-office, ou null sans adresse configurée. */
export function backOffice(context: RuleContext, path: string): string | null {
  return context.backOfficeBaseUrl ? `${context.backOfficeBaseUrl}${path}` : null;
}

export const backOfficePath = {
  request: (requestId: string) => `/nettoyage/demandes/${id(requestId)}`,
  program: (programId: string) => `/nettoyage/programmes/${id(programId)}`,
  session: (programId: string, sessionId: string) =>
    `/nettoyage/programmes/${id(programId)}/seances/${id(sessionId)}`,
  claim: (claimId: string) => `/nettoyage/reclamations/${id(claimId)}`,
  agent: (agentId: string) => `/nettoyage/agents/${id(agentId)}`,
  organization: (organizationId: string) => `/nettoyage/organisations/${id(organizationId)}`,
};

/** Message au client du dossier (titulaire ou auteur de la demande). */
export function customer(
  event: Owner,
  templateCode: string,
  link: string,
  variables: Record<string, string>,
): NotificationIntent {
  return { userId: event.customerId, templateCode, variables: { ...variables, link }, link };
}

/**
 * Message au « client » au sens de 16.2 pour l'argent et la suspension : le particulier, ou les
 * administrateurs actuels de l'organisation (avec la copie à l'e-mail de facturation, ADR-050).
 */
export function payer(
  event: Owner,
  templateCode: string,
  link: string,
  variables: Record<string, string>,
): NotificationIntent {
  const intent = customer(event, templateCode, link, variables);
  return event.organizationId ? { ...intent, organizationId: event.organizationId } : intent;
}

/** Un message par agent, chacun une seule fois (application agent, sans lien). */
export function agents(
  agentIds: readonly string[],
  templateCode: string,
  variables: Record<string, string>,
): NotificationIntent[] {
  return [...new Set(agentIds)].map((userId) => ({ userId, templateCode, variables, link: null }));
}

/**
 * Message au personnel qui porte la permission dans la zone (superviseur de la zone ; un admin,
 * attribution globale, aussi) ; `zoneKey` null : attributions globales seulement (événement sans
 * clé de commune).
 */
export function staff(
  permission: CleaningStaffPermission,
  zoneKey: string | null,
  templateCode: string,
  link: string | null,
  variables: Record<string, string>,
): NotificationIntent {
  return {
    userId: '',
    templateCode,
    variables: link ? { ...variables, link } : variables,
    link,
    staff: { permission, zoneKey },
  };
}

/** « séance 3 sur 12 du programme PN-000057 » ; « séance du programme PN-000058 » pour un ponctuel. */
export function sessionLabel(event: { rank: number; sessionsCount: number; programNumber: string }): string {
  return event.sessionsCount === 1
    ? `séance du programme ${event.programNumber}`
    : `séance ${event.rank} sur ${event.sessionsCount} du programme ${event.programNumber}`;
}

/** « Maison (Nettoyage des sols, Vitres) » : libellés du catalogue en vigueur (RV-02). */
export function placeLabel(event: { placeTypeName: string; cleaningTypeNames: readonly string[] }): string {
  return event.cleaningTypeNames.length > 0
    ? `${event.placeTypeName} (${event.cleaningTypeNames.join(', ')})`
    : event.placeTypeName;
}

type SuspensionCause = CleaningEventPayloads['cleaning.program.suspended']['causes'][number];

export const SUSPENSION_CAUSES: Readonly<Record<SuspensionCause, string>> = {
  overdue_sessions: 'séances en retard de paiement',
  unpaid_invoices: 'factures impayées',
  ksp_decision: 'décision de KSP',
  organization_suspended: 'compte entreprise suspendu',
};

export function causesLabel(causes: readonly SuspensionCause[]): string {
  return [...new Set(causes)].map((cause) => SUSPENSION_CAUSES[cause]).join(', ');
}

export const INCIDENT_CATEGORIES: Readonly<
  Record<CleaningEventPayloads['cleaning.session.interrupted']['category'], string>
> = {
  equipment: 'matériel',
  access: 'accès',
  safety: 'sécurité',
  out_of_scope_request: 'demande hors devis',
  other: 'autre',
};

export const CLAIM_CATEGORIES: Readonly<
  Record<CleaningEventPayloads['cleaning.claim.opened']['category'], string>
> = {
  incomplete_work: 'travail incomplet',
  damage: 'dégât',
  behavior: 'comportement',
  missing_item: 'objet manquant',
  other: 'autre',
};

export const DECLINE_REASONS: Readonly<
  Record<NonNullable<CleaningEventPayloads['cleaning.quote.declined']['reasonCode']>, string>
> = {
  price: 'prix',
  schedule: 'calendrier',
  no_longer_needed: 'plus besoin',
  other: 'autre',
};

export const MISSED_CAUSES: Readonly<
  Record<CleaningEventPayloads['cleaning.session.missed']['cause'], string>
> = {
  customer_absent: 'client absent',
  access_impossible: 'accès impossible',
  late_cancellation: 'annulation tardive',
};

export const REJECTION_REASONS: Readonly<
  Record<CleaningEventPayloads['cleaning.request.rejected']['reasonCode'], string>
> = {
  place_inaccessible: 'lieu inaccessible',
  service_impossible: 'prestation impossible',
  other: 'autre motif',
};

type LeftInWallet = CleaningEventPayloads['cleaning.direct_payment.left_in_wallet'];

export const PAID_OBJECTS: Readonly<Record<LeftInWallet['objectType'], string>> = {
  visit_fee: 'des frais de visite',
  session: 'une séance',
};

export const LEFT_IN_WALLET_CAUSES: Readonly<Record<LeftInWallet['cause'], string>> = {
  request_closed: 'demande close',
  already_paid: 'déjà payé',
  waived: 'dispensé de paiement',
  cancelled: 'annulé',
};
