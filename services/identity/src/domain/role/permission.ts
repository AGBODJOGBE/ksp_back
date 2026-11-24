import { SUPER_ADMIN_ROLE } from './role-administration';

/**
 * Permissions et rôles gérés (CDC Nettoyage v2, partie 2 ; ADR-057). Une permission est déclarée par
 * le code de son service (R-RB-01) ; un rôle coche des permissions (R-RB-02) ; une attribution peut
 * être limitée à des communes (portée zone, R-RB-03).
 */

const PERMISSION_CODE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const MANAGED_ROLE_CODE = /^[a-z][a-z0-9_]{2,63}$/;
/** Clé de commune du référentiel de geo (même motif que le jeton d'accès). */
const ZONE_KEY = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const ROLE_NAME_MAX_LENGTH = 80;
export const ROLE_DESCRIPTION_MAX_LENGTH = 500;
export const ROLE_MAX_PERMISSIONS = 500;
/** 77 communes au Bénin. */
export const MAX_ZONE_KEYS = 77;

export function isPermissionCode(code: string): boolean {
  return PERMISSION_CODE.test(code);
}

/** Service qui déclare la permission : premier segment du code. */
export function permissionService(code: string): string {
  return code.split('.')[0] ?? '';
}

/** Module affiché au back-office pour grouper les cases : deuxième segment du code. */
export function permissionModule(code: string): string {
  return code.split('.')[1] ?? '';
}

/** Un rôle actif d'un compte, vu pour le calcul de ses permissions. */
export interface PermissionGrant {
  code: string;
  /** Vide : attribution sans limite de zone. */
  zoneKeys: readonly string[];
  /** Permissions cochées du rôle, retirées exclues. */
  permissions: readonly string[];
}

/** Permissions écrites dans le jeton d'accès (revendications perms et zone_perms). */
export interface EffectivePermissions {
  perms: string[];
  zonePerms: Record<string, string[]>;
}

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

/**
 * Permissions effectives d'un compte du personnel (R-RB-03) : union des permissions de ses rôles.
 * Une attribution limitée à des zones ne vaut que dans ces communes ; une permission déjà valable
 * partout n'est pas répétée dans les zones, et une zone sans permission propre est omise.
 * super_admin reçoit toutes les permissions du catalogue (ADR-057, à valider).
 */
export function effectivePermissions(
  grants: readonly PermissionGrant[],
  catalog: { allPermissions: readonly string[] },
): EffectivePermissions {
  const global = new Set<string>();
  for (const grant of grants) {
    if (grant.zoneKeys.length) continue;
    grant.permissions.forEach((permission) => global.add(permission));
    if (grant.code === SUPER_ADMIN_ROLE)
      catalog.allPermissions.forEach((permission) => global.add(permission));
  }
  const byZone = new Map<string, Set<string>>();
  for (const grant of grants) {
    for (const zone of grant.zoneKeys) {
      const set = byZone.get(zone) ?? new Set<string>();
      grant.permissions.filter((permission) => !global.has(permission)).forEach((p) => set.add(p));
      byZone.set(zone, set);
    }
  }
  const zonePerms: Record<string, string[]> = {};
  for (const zone of [...byZone.keys()].sort()) {
    const permissions = byZone.get(zone);
    if (permissions?.size) zonePerms[zone] = sorted(permissions);
  }
  return { perms: sorted(global), zonePerms };
}

/** Saisie d'un rôle créé ou modifié au back-office. */
export interface RoleInput {
  code: string;
  name: string;
  description: string;
  permissions: readonly string[];
}

/** Premier champ invalide (details.field de IDENTITY_ROLE_INVALID) ; null si tout est valide. */
export function roleInputProblem(input: RoleInput): 'code' | 'name' | 'description' | 'permissions' | null {
  if (!MANAGED_ROLE_CODE.test(input.code)) return 'code';
  const name = input.name.trim();
  if (!name || name.length > ROLE_NAME_MAX_LENGTH) return 'name';
  if (input.description.length > ROLE_DESCRIPTION_MAX_LENGTH) return 'description';
  if (
    input.permissions.length > ROLE_MAX_PERMISSIONS ||
    new Set(input.permissions).size !== input.permissions.length ||
    !input.permissions.every(isPermissionCode)
  ) {
    return 'permissions';
  }
  return null;
}

/** Zones d'une attribution : 1 à 77 clés de commune bien formées, sans doublon. */
export function invalidZoneKeys(keys: readonly string[]): boolean {
  return (
    keys.length === 0 ||
    keys.length > MAX_ZONE_KEYS ||
    new Set(keys).size !== keys.length ||
    !keys.every((key) => ZONE_KEY.test(key))
  );
}
