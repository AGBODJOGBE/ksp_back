import { identityV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { type CatalogRole, type PermissionCatalog } from '../../application/rbac/permission-catalog';
import {
  type CatalogRegistrationResult,
  type PermissionCatalogRegistry,
} from '../../application/rbac/rbac.ports';

const SCOPE_TYPE: Readonly<Record<CatalogRole['scopeType'], identityV1.ScopeType>> = {
  global: identityV1.ScopeType.SCOPE_TYPE_GLOBAL,
  domain: identityV1.ScopeType.SCOPE_TYPE_DOMAIN,
};

/**
 * Catalogue des permissions déclaré à identity (IdentityService.RegisterCatalog, R-RB-01), avec le
 * jeton de service de cleaning. L'appel est rejouable (une version déjà enregistrée est sans effet) :
 * une panne passagère est retentée une fois par le GrpcCaller. Les refus d'identity
 * (IDENTITY_CATALOG_INVALID…) sont rendus tels quels à l'appelant, qui les journalise.
 */
export class IdentityPermissionCatalog implements PermissionCatalogRegistry {
  constructor(
    private readonly client: identityV1.IdentityServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async register(catalog: PermissionCatalog): Promise<CatalogRegistrationResult> {
    const response = await this.caller.call(
      'registerCatalog',
      (metadata) =>
        this.client.registerCatalog(
          {
            service: catalog.service,
            catalogVersion: catalog.version,
            // `service`, `module` et `retired` sont renseignés par identity dans ses réponses.
            permissions: catalog.permissions.map((permission) => ({
              code: permission.code,
              description: permission.description,
              service: '',
              module: '',
              retired: false,
            })),
            roles: catalog.roles.map((role) => ({
              code: role.code,
              scopeType: SCOPE_TYPE[role.scopeType],
              requiresMfa: role.requiresMfa,
              description: role.description,
              permissions: [...role.permissions],
              name: role.name,
              sensitive: role.sensitive,
              backofficeAccess: role.backofficeAccess,
            })),
          },
          metadata,
        ),
      { idempotent: true },
    );
    return {
      permissionsAdded: response.permissionsAdded,
      permissionsRetired: response.permissionsRetired,
      rolesCreated: response.rolesCreated,
    };
  }
}
