import { hasRole, requireCaller, requireUser } from '@ksp/platform';
import { type OrganizationRole } from '../../domain/requests/organization-access';
import { type WalletHolder } from '../money/money.ports';
import { GATEWAY_CALLERS } from '../shared/access';
import { type Owner } from './requests.ports';

/**
 * Client connecté de l'espace client (relayé par la gateway). Le titulaire est le contexte actif :
 * le compte personnel, ou l'organisation au nom de laquelle il agit (UC-ID-15). Son rôle dans
 * l'organisation fixe ses droits sur le dossier (R-CP-03, RV-11) ; null en contexte personnel.
 */
export interface Customer {
  userId: string;
  owner: Owner;
  organizationId: string | null;
  role: OrganizationRole | null;
}

/** Du plus fort au plus faible : le rôle retenu est le plus fort détenu dans l'organisation. */
const ROLES: readonly OrganizationRole[] = ['org_admin', 'org_member', 'org_viewer'];

export function currentCustomer(): Customer {
  requireCaller(GATEWAY_CALLERS);
  const user = requireUser();
  const organizationId = user.activeContext && user.activeContext !== 'personal' ? user.activeContext : null;
  if (!organizationId) {
    return {
      userId: user.userId,
      owner: { kind: 'user', id: user.userId },
      organizationId: null,
      role: null,
    };
  }
  // Interprétation prudente : sans rôle connu dans l'organisation active, lecture seule.
  const role =
    ROLES.find((candidate) => hasRole(user, candidate, { type: 'org', id: organizationId })) ?? 'org_viewer';
  return {
    userId: user.userId,
    owner: { kind: 'organization', id: organizationId },
    organizationId,
    role,
  };
}

/**
 * Dossier ou lieu du titulaire du contexte actif (R-CP-04) ; hors de ce périmètre : introuvable
 * (NOT_FOUND chez l'appelant, sans révéler l'objet).
 */
export function ownedBy(customer: Customer, owner: Owner): boolean {
  return owner.kind === customer.owner.kind && owner.id === customer.owner.id;
}

export function holderOf(owner: Owner): WalletHolder {
  return { type: owner.kind, id: owner.id };
}
