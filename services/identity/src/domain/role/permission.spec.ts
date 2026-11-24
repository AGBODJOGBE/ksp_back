import {
  effectivePermissions,
  isPermissionCode,
  permissionModule,
  permissionService,
  roleInputProblem,
  invalidZoneKeys,
} from './permission';

describe('code de permission (R-RB-01)', () => {
  it('suit le format <service>.<ressource>.<action>', () => {
    expect(isPermissionCode('cleaning.request.process')).toBe(true);
    expect(isPermissionCode('cleaning.quote.adjust_price')).toBe(true);
    expect(isPermissionCode('cleaning.request')).toBe(false);
    expect(isPermissionCode('Cleaning.request.read')).toBe(false);
    expect(isPermissionCode('cleaning.request.read.all')).toBe(false);
    expect(isPermissionCode('')).toBe(false);
  });

  it('donne le service (premier segment) et le module (deuxième segment)', () => {
    expect(permissionService('cleaning.planning.manage')).toBe('cleaning');
    expect(permissionModule('cleaning.planning.manage')).toBe('planning');
  });
});

describe('permissions effectives du jeton (perms, zone_perms)', () => {
  const role = (permissions: string[], zoneKeys: string[] = [], code = 'r') => ({
    code,
    zoneKeys,
    permissions,
  });

  it('union des permissions des rôles sans zone, triée et sans doublon', () => {
    const result = effectivePermissions(
      [role(['cleaning.request.read', 'cleaning.catalog.read']), role(['cleaning.request.read'])],
      { allPermissions: [] },
    );
    expect(result).toEqual({ perms: ['cleaning.catalog.read', 'cleaning.request.read'], zonePerms: {} });
  });

  it('une attribution limitée à des zones ne donne ses permissions que dans ces communes', () => {
    const result = effectivePermissions(
      [
        role(['cleaning.catalog.read']),
        role(['cleaning.request.process', 'cleaning.catalog.read'], ['porto-novo', 'cotonou']),
        role(['cleaning.planning.manage'], ['cotonou']),
      ],
      { allPermissions: [] },
    );
    expect(result.perms).toEqual(['cleaning.catalog.read']);
    // Une permission déjà valable partout n'est pas répétée dans les zones.
    expect(result.zonePerms).toEqual({
      cotonou: ['cleaning.planning.manage', 'cleaning.request.process'],
      'porto-novo': ['cleaning.request.process'],
    });
  });

  it('une zone sans permission propre est omise', () => {
    const result = effectivePermissions(
      [role(['cleaning.catalog.read']), role(['cleaning.catalog.read'], ['ouidah'])],
      { allPermissions: [] },
    );
    expect(result.zonePerms).toEqual({});
  });

  it('super_admin reçoit toutes les permissions du catalogue', () => {
    const result = effectivePermissions([role([], [], 'super_admin')], {
      allPermissions: ['wallet.withdrawal.approve', 'cleaning.catalog.read'],
    });
    expect(result.perms).toEqual(['cleaning.catalog.read', 'wallet.withdrawal.approve']);
  });
});

describe('saisie d’un rôle géré (R-RB-02)', () => {
  const valid = { code: 'cleaning_planner', name: 'Planificateur', description: 'Planifie', permissions: [] };

  it('accepte un rôle bien formé', () => {
    expect(roleInputProblem(valid)).toBeNull();
  });

  it('refuse un code mal formé, trop court ou trop long', () => {
    expect(roleInputProblem({ ...valid, code: 'Planner' })).toBe('code');
    expect(roleInputProblem({ ...valid, code: 'ab' })).toBe('code');
    expect(roleInputProblem({ ...valid, code: `a${'b'.repeat(64)}` })).toBe('code');
  });

  it('exige un nom de 1 à 80 caractères et une description de 500 caractères au plus', () => {
    expect(roleInputProblem({ ...valid, name: '  ' })).toBe('name');
    expect(roleInputProblem({ ...valid, name: 'n'.repeat(81) })).toBe('name');
    expect(roleInputProblem({ ...valid, description: 'd'.repeat(501) })).toBe('description');
  });

  it('refuse des permissions mal formées, en double ou trop nombreuses', () => {
    expect(roleInputProblem({ ...valid, permissions: ['cleaning.read'] })).toBe('permissions');
    expect(
      roleInputProblem({ ...valid, permissions: ['cleaning.request.read', 'cleaning.request.read'] }),
    ).toBe('permissions');
    const many = Array.from({ length: 501 }, (_, i) => `cleaning.module.action_${i}`);
    expect(roleInputProblem({ ...valid, permissions: many })).toBe('permissions');
  });
});

describe('zones d’une attribution (R-RB-03)', () => {
  it('1 à 77 clés de commune bien formées, sans doublon', () => {
    expect(invalidZoneKeys(['porto-novo', 'cotonou'])).toBe(false);
    expect(invalidZoneKeys([])).toBe(true);
    expect(invalidZoneKeys(['cotonou', 'cotonou'])).toBe(true);
    expect(invalidZoneKeys(['Cotonou'])).toBe(true);
    expect(invalidZoneKeys(Array.from({ length: 78 }, (_, i) => `commune-${i}`))).toBe(true);
  });
});
