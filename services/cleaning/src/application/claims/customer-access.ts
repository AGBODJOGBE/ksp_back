import { requireCaller, requireUser } from '@ksp/platform';
import { type OrganizationRole } from '../../domain/requests/organization-access';
import { GATEWAY_CALLERS } from '../shared/access';
import { lotGErrors } from '../shared/lot-g.errors';

/**
 * Accès du client à ses dossiers (lot G : réclamations, renouvellement). Contexte personnel : le
 * compte connecté est le titulaire. Contexte d'une organisation : l'organisation est le titulaire,
 * et le rôle de l'appelant dans l'organisation borne ses actions (R-CP-03, RV-11).
 */
export interface CustomerAccess {
  userId: string;
  owner: { kind: 'user' | 'organization'; id: string };
  /** Rôle dans l'organisation ; null en contexte personnel (tous les droits). */
  role: OrganizationRole | null;
}

const RANK: Record<OrganizationRole, number> = { org_viewer: 1, org_member: 2, org_admin: 3 };

/** Compte connecté et titulaire du contexte actif ; AUTH_FORBIDDEN sans rôle dans l'organisation. */
export function requireCustomer(): CustomerAccess {
  requireCaller(GATEWAY_CALLERS);
  const user = requireUser();
  if (!user.activeContext || user.activeContext === 'personal') {
    return { userId: user.userId, owner: { kind: 'user', id: user.userId }, role: null };
  }
  const organizationId = user.activeContext;
  const roles = user.roles
    .filter((claim) => claim.scopeType === 'org' && claim.scopeId === organizationId && claim.role in RANK)
    .map((claim) => claim.role as OrganizationRole)
    .sort((a, b) => RANK[b] - RANK[a]);
  if (!roles.length) throw lotGErrors.forbidden();
  return { userId: user.userId, owner: { kind: 'organization', id: organizationId }, role: roles[0]! };
}

/** Rôle au moins égal à `minimum` (contexte personnel : toujours) ; sinon AUTH_FORBIDDEN. */
export function requireOrganizationRole(access: CustomerAccess, minimum: OrganizationRole): void {
  if (access.role !== null && RANK[access.role] < RANK[minimum]) throw lotGErrors.forbidden();
}

/** Le dossier appartient au titulaire du contexte actif. */
export function ownsCase(access: CustomerAccess, owner: { ownerKind: string; ownerId: string }): boolean {
  return owner.ownerKind === access.owner.kind && owner.ownerId === access.owner.id;
}
