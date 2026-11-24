/**
 * Rôles et attributions (cahier des charges Identité, partie 5). Un rôle appartient au service qui
 * le déclare ; Identité l'enregistre et l'attribue avec une portée.
 */
export type RoleScopeType = 'global' | 'domain' | 'org' | 'personal' | 'zone';

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
  /** Nom affiché (ADR-057) ; absent ou vide : le code. */
  name?: string | null;
  /** Son retrait révoque immédiatement les sessions de la personne (R-RB-05). */
  sensitive?: boolean;
  /** false : désactivé, ne s'attribue plus (R-RB-02). Absent : actif. */
  active?: boolean;
  /** "default" (livré par un service) ou "custom" (créé au back-office). */
  origin?: 'default' | 'custom';
}

/** Un rôle attribué à un compte, encore actif. */
export interface AssignedRole {
  code: string;
  scopeType: RoleScopeType;
  /** Nom du service pour une portée domain, identifiant de l'organisation pour une portée org. */
  scopeId: string | null;
  requiresMfa: boolean;
  backofficeAccess: boolean;
  /** Portée zone : clés de commune de l'attribution (R-RB-03) ; vide pour une autre portée. */
  zoneKeys: string[];
  /** Permissions cochées du rôle, retirées exclues (ADR-057). */
  permissions: string[];
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
  internal('recovery', 'recovery_admin', 'domain', 'Responsable du métier Recouvrement'),
  internal('recovery', 'recovery_agent', 'domain', 'Agent de recouvrement'),
];

/**
 * Rôle hors du back-office : partenaire externe (huissier, avocat, ADR-060) ou agent de terrain. Ni
 * back-office ni double authentification.
 */
const partner = (service: string, code: string, description: string): RoleDefinition => ({
  service,
  code,
  scopeType: 'domain',
  requiresMfa: false,
  backofficeAccess: false,
  description,
});

/**
 * Rôles du Recouvrement ajoutés par la migration 0011 (ADR-060) : superviseur et juriste au
 * back-office ; huissier et avocat partenaires, qui n'accèdent qu'à leurs dossiers assignés
 * (/api/v1/recovery/partner), sans double authentification (décision du 2026-11-20 : la finance
 * valide à deux les sommes qu'ils déclarent).
 */
export const RECOVERY_ROLES: readonly RoleDefinition[] = [
  internal('recovery', 'recovery_supervisor', 'domain', 'Superviseur du recouvrement'),
  internal('recovery', 'legal_officer', 'domain', 'Juriste du recouvrement'),
  partner('recovery', 'recovery_bailiff', 'Huissier de justice partenaire du recouvrement'),
  partner('recovery', 'recovery_lawyer', 'Avocat partenaire du recouvrement'),
];

/**
 * Rôle de terrain du Nettoyage (CDC Nettoyage v2, R-RB-07) : l'agent se connecte à l'application agent
 * par code et appareil enregistré, sans back-office ni application d'authentification. La migration
 * 0004 l'avait enregistré comme un rôle du back-office ; la migration 0013 le corrige.
 */
export const FIELD_ROLES: readonly RoleDefinition[] = [
  partner('cleaning', 'cleaning_agent', 'Agent de terrain du nettoyage'),
];

/** Catalogue complet enregistré par les migrations. */
export const ROLE_CATALOG: readonly RoleDefinition[] = [
  ...INITIAL_BACKOFFICE_ROLES,
  ...FIELD_ROLES,
  ...RECOVERY_ROLES,
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
