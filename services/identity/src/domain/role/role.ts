/**
 * Rôles et attributions (cahier des charges Identité, partie 5). Un rôle appartient au service qui
 * le déclare ; Identité l'enregistre et l'attribue avec une portée.
 */
export type RoleScopeType = 'global' | 'domain' | 'org' | 'personal';

export interface RoleDefinition {
  /** Service qui déclare le rôle (identity, cleaning, recovery, wallet…). */
  service: string;
  code: string;
  scopeType: RoleScopeType;
  /** Double authentification exigée pour tout compte qui a ce rôle. */
  requiresMfa: boolean;
  /** Donne accès au back-office (colonne « Back-office » de la partie 5). */
  backofficeAccess: boolean;
  description: string;
}

/** Un rôle attribué à un compte, encore actif. */
export interface AssignedRole {
  code: string;
  scopeType: RoleScopeType;
  /** Nom du service pour une portée domain, identifiant de l'organisation pour une portée org. */
  scopeId: string | null;
  requiresMfa: boolean;
  backofficeAccess: boolean;
}

const internal = (
  service: string,
  code: string,
  scopeType: RoleScopeType,
  description: string,
): RoleDefinition => ({ service, code, scopeType, requiresMfa: true, backofficeAccess: true, description });

/**
 * Catalogue initial des rôles du back-office, enregistré par la migration 0004. Les services
 * métier déclareront leurs propres catalogues (RegisterCatalog) quand ils existeront.
 */
export const INITIAL_BACKOFFICE_ROLES: readonly RoleDefinition[] = [
  internal(
    'identity',
    'super_admin',
    'global',
    'Direction KSP : tout l’écosystème, y compris les admins métier',
  ),
  internal(
    'identity',
    'support_agent',
    'global',
    'Support client : consultation des comptes et des dossiers',
  ),
  internal('wallet', 'finance_officer', 'domain', 'Validation des versements'),
  internal('cleaning', 'cleaning_admin', 'domain', 'Responsable du métier Nettoyage'),
  internal('cleaning', 'cleaning_supervisor', 'domain', 'Superviseur des missions de nettoyage'),
  internal('cleaning', 'cleaning_agent', 'domain', 'Agent de terrain du nettoyage'),
  internal('recovery', 'recovery_admin', 'domain', 'Responsable du métier Recouvrement'),
  internal('recovery', 'recovery_agent', 'domain', 'Agent de recouvrement'),
];

const ROLE_CODE = /^[a-z][a-z0-9_]*$/;

/**
 * Règles d'un catalogue de rôles : codes valides et uniques, et « tout rôle qui donne accès au
 * back-office exige la double authentification » (partie 5). Renvoie la liste des problèmes.
 */
export function catalogProblems(roles: readonly RoleDefinition[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const role of roles) {
    if (!ROLE_CODE.test(role.code)) problems.push(`${role.code} : code invalide`);
    if (seen.has(role.code)) problems.push(`${role.code} : code en double`);
    seen.add(role.code);
    if (role.backofficeAccess && !role.requiresMfa) {
      problems.push(`${role.code} : rôle du back-office sans double authentification`);
    }
    if (role.scopeType === 'personal' && role.backofficeAccess) {
      problems.push(`${role.code} : un rôle personnel ne donne pas accès au back-office`);
    }
  }
  return problems;
}

/** Rôles du compte qui ouvrent le back-office ; vide : accès refusé. */
export function backofficeRoles(assigned: readonly AssignedRole[]): AssignedRole[] {
  return assigned.filter((role) => role.backofficeAccess);
}

/**
 * Portée d'une attribution faite sans écran d'administration (amorçage) : globale pour un rôle
 * global, le service du rôle pour un rôle de métier. Null pour une portée d'organisation ou
 * personnelle, qui ne s'attribue pas ainsi (organisations : UC-ID-13).
 */
export function defaultAssignmentScope(
  role: RoleDefinition,
): { scopeType: RoleScopeType; scopeId: string | null } | null {
  if (role.scopeType === 'domain') return { scopeType: 'domain', scopeId: role.service };
  if (role.scopeType === 'global') return { scopeType: 'global', scopeId: null };
  return null;
}
