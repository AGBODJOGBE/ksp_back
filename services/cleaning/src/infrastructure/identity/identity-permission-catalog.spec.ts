import { identityV1 } from '@ksp/contracts';
import { AppError, GrpcCaller } from '@ksp/platform';
import { of, throwError } from 'rxjs';
import { CLEANING_PERMISSION_CATALOG } from '../../application/rbac/permission-catalog';
import { IdentityPermissionCatalog } from './identity-permission-catalog';

function registry(answer: () => unknown) {
  const requests: identityV1.RegisterCatalogRequest[] = [];
  const client = {
    registerCatalog: (request: identityV1.RegisterCatalogRequest) => {
      requests.push(request);
      return answer();
    },
  } as unknown as identityV1.IdentityServiceClient;
  return {
    requests,
    catalog: new IdentityPermissionCatalog(client, new GrpcCaller({ target: 'identity', retryBackoffMs: 1 })),
  };
}

describe('IdentityPermissionCatalog (identity.RegisterCatalog, R-RB-01)', () => {
  it('déclare le service, la version, les permissions et les rôles livrés par défaut', async () => {
    const { catalog, requests } = registry(() =>
      of({ accepted: true, permissionsAdded: 16, permissionsRetired: 0, rolesCreated: 0 }),
    );
    await expect(catalog.register(CLEANING_PERMISSION_CATALOG)).resolves.toEqual({
      permissionsAdded: 16,
      permissionsRetired: 0,
      rolesCreated: 0,
    });
    const [request] = requests;
    expect(request).toMatchObject({ service: 'cleaning', catalogVersion: 1 });
    expect(request!.permissions).toHaveLength(16);
    expect(request!.permissions[0]).toEqual({
      code: 'cleaning.catalog.read',
      description: 'Lire les lieux, types, paramètres, tarifs, packs et listes de contrôle',
      service: '',
      module: '',
      retired: false,
    });
    expect(request!.roles.map((role) => [role.code, role.scopeType])).toEqual([
      ['cleaning_admin', identityV1.ScopeType.SCOPE_TYPE_DOMAIN],
      ['cleaning_supervisor', identityV1.ScopeType.SCOPE_TYPE_DOMAIN],
      ['cleaning_agent', identityV1.ScopeType.SCOPE_TYPE_DOMAIN],
      ['finance_officer', identityV1.ScopeType.SCOPE_TYPE_DOMAIN],
      ['support_agent', identityV1.ScopeType.SCOPE_TYPE_GLOBAL],
    ]);
    expect(request!.roles[2]).toEqual({
      code: 'cleaning_agent',
      scopeType: identityV1.ScopeType.SCOPE_TYPE_DOMAIN,
      requiresMfa: false,
      description: 'Agent de terrain du Nettoyage : visites et séances qui lui sont affectées',
      permissions: ['cleaning.visit.perform', 'cleaning.session.perform'],
      name: 'Agent de nettoyage',
      sensitive: false,
      backofficeAccess: false,
    });
  });

  it('une panne passagère est rejouée une fois (déclaration rejouable) ; un refus est rendu tel quel', async () => {
    let calls = 0;
    const flaky = registry(() => {
      calls += 1;
      return calls === 1
        ? throwError(() => new AppError('UNAVAILABLE', 'GRPC_UNAVAILABLE', 'identity injoignable'))
        : of({ accepted: true, permissionsAdded: 0, permissionsRetired: 0, rolesCreated: 0 });
    });
    await expect(flaky.catalog.register(CLEANING_PERMISSION_CATALOG)).resolves.toMatchObject({
      permissionsAdded: 0,
    });
    expect(calls).toBe(2);
    const refused = registry(() =>
      throwError(() => AppError.invalid('IDENTITY_CATALOG_INVALID', 'Le catalogue déclaré est invalide.')),
    );
    await expect(refused.catalog.register(CLEANING_PERMISSION_CATALOG)).rejects.toMatchObject({
      code: 'IDENTITY_CATALOG_INVALID',
    });
    expect(refused.requests).toHaveLength(1);
  });
});
