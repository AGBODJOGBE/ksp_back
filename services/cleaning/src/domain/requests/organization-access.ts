import { DomainRuleError } from './errors';

/** Rôle de l'appelant dans l'organisation du contexte actif (R-CP-03). */
export type OrganizationRole = 'org_viewer' | 'org_member' | 'org_admin';

/** Actions du client sur un dossier du lot C (demande, frais, visite, devis). */
export const CLIENT_CASE_ACTIONS = [
  'view',
  'submit_request',
  'pay_visit_fee',
  'change_visit_slot',
  'cancel_request',
  'request_reactivation',
  'forward_quote',
  'accept_quote',
  'decline_quote',
] as const;

export type ClientCaseAction = (typeof CLIENT_CASE_ACTIONS)[number];

/**
 * Matrice R-CP-03 (RV-11) : lecteur, consultation ; membre, demandes et suivi, transmission du devis ;
 * administrateur, en plus, acceptation et refus du devis (R-AC-02).
 */
const RIGHTS: Readonly<Record<OrganizationRole, readonly ClientCaseAction[]>> = {
  org_viewer: ['view'],
  org_member: [
    'view',
    'submit_request',
    'pay_visit_fee',
    'change_visit_slot',
    'cancel_request',
    'request_reactivation',
    'forward_quote',
  ],
  org_admin: CLIENT_CASE_ACTIONS,
};

/** `role` null : contexte personnel, le titulaire du dossier a tous les droits. */
export function hasOrganizationRight(role: OrganizationRole | null, action: ClientCaseAction): boolean {
  return role === null || RIGHTS[role].includes(action);
}

/** Rôle insuffisant : AUTH_FORBIDDEN avec le rôle de l'appelant (RV-11). */
export function assertOrganizationRight(role: OrganizationRole | null, action: ClientCaseAction): void {
  if (!hasOrganizationRight(role, action)) {
    throw new DomainRuleError('AUTH_FORBIDDEN', { organizationRole: role });
  }
}
