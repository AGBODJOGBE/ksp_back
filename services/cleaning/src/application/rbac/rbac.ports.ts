import { type PermissionCatalog } from './permission-catalog';

/** Bilan d'une déclaration ; tout à 0 pour une version déjà enregistrée. */
export interface CatalogRegistrationResult {
  permissionsAdded: number;
  permissionsRetired: number;
  rolesCreated: number;
}

/**
 * Déclaration du catalogue des permissions à identity (RegisterCatalog, R-RB-01), avec le jeton de
 * service de cleaning : le service déclaré est toujours celui du jeton. Rejouable sans effet.
 */
export interface PermissionCatalogRegistry {
  register(catalog: PermissionCatalog): Promise<CatalogRegistrationResult>;
}
