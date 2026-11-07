import { PhoneNumber } from '../user/phone-number';
import { type RoleDefinition, type RoleScopeType } from './role';

/**
 * Administration des comptes et des rôles au back-office (ADR-038, UC-ID-18 à 20) : qui peut
 * attribuer quel rôle, qui peut agir sur un compte, et dans quel état.
 */

export const SUPER_ADMIN_ROLE = 'super_admin';

/**
 * Administrateur de chaque métier : il gère les rôles de son métier (agents, superviseurs), jamais
 * le sien ni ceux d'un autre métier. Un métier sans administrateur déclaré ici n'en a pas.
 */
export const DOMAIN_ADMIN_ROLES: Readonly<Record<string, string>> = {
  cleaning: 'cleaning_admin',
  recovery: 'recovery_admin',
};

/** Rôles qui ouvrent l'administration des comptes. */
export const ACCOUNT_ADMIN_ROLES: readonly string[] = [
  SUPER_ADMIN_ROLE,
  ...Object.values(DOMAIN_ADMIN_ROLES),
];

/**
 * Périmètre d'un administrateur : tout l'écosystème (super_admin), ou les métiers dont il est
 * l'administrateur.
 */
export type AdminPerimeter = { kind: 'all' } | { kind: 'domains'; services: readonly string[] };

/** Périmètre tiré des rôles de l'appelant ; null s'il n'administre rien. */
export function perimeterOf(roleCodes: readonly string[]): AdminPerimeter | null {
  if (roleCodes.includes(SUPER_ADMIN_ROLE)) return { kind: 'all' };
  const services = Object.entries(DOMAIN_ADMIN_ROLES)
    .filter(([, admin]) => roleCodes.includes(admin))
    .map(([service]) => service);
  return services.length ? { kind: 'domains', services } : null;
}

/** Portées attribuables depuis le back-office : un rôle d'organisation ou personnel ne l'est pas. */
export function isAssignableScope(scopeType: RoleScopeType): boolean {
  return scopeType === 'global' || scopeType === 'domain';
}

/**
 * L'administrateur peut-il attribuer ou retirer ce rôle ? super_admin : tout rôle attribuable ;
 * administrateur de métier : les rôles de portée métier de son métier, sauf le sien (personne ne
 * crée un pair ni un supérieur).
 */
export function canManageRole(
  perimeter: AdminPerimeter,
  role: Pick<RoleDefinition, 'code' | 'service' | 'scopeType'>,
): boolean {
  if (!isAssignableScope(role.scopeType)) return false;
  if (perimeter.kind === 'all') return true;
  return (
    role.scopeType === 'domain' &&
    perimeter.services.includes(role.service) &&
    DOMAIN_ADMIN_ROLES[role.service] !== role.code
  );
}

/** Suspension, réactivation et réinitialisation de la double authentification : super_admin seul. */
export function canManageAccounts(perimeter: AdminPerimeter): boolean {
  return perimeter.kind === 'all';
}

/** Numéro complet affiché : super_admin seul ; masqué pour un administrateur de métier. */
export function seesFullPhone(perimeter: AdminPerimeter): boolean {
  return perimeter.kind === 'all';
}

export type AccountAction = 'suspend' | 'reactivate';

/** Transition de l'état d'un compte ; null si l'action n'est pas possible dans cet état. */
export function accountTransition(status: string, action: AccountAction): 'active' | 'suspended' | null {
  if (action === 'suspend') return status === 'active' ? 'suspended' : null;
  return status === 'suspended' ? 'active' : null;
}

export const ACCOUNT_QUERY_MAX_LENGTH = 100;
const NAME_MIN_LENGTH = 2;

/** Recherche de compte : équipe (vide), numéro complet ou mots du nom. */
export type AccountQuery =
  { kind: 'staff' } | { kind: 'phone'; e164: string } | { kind: 'name'; words: string[] };

/** Lit la recherche ; null si elle est trop courte ou trop longue. */
export function parseAccountQuery(value: string): AccountQuery | null {
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text) return { kind: 'staff' };
  if (text.length > ACCOUNT_QUERY_MAX_LENGTH) return null;
  const phone = PhoneNumber.parse(text);
  if (phone) return { kind: 'phone', e164: phone.e164 };
  // Jokers de LIKE retirés : un nom est cherché tel quel.
  const words = text
    .replace(/[%_\\]/g, '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 5);
  if (words.join('').replace(/['’-]/g, '').length < NAME_MIN_LENGTH) return null;
  return { kind: 'name', words };
}
