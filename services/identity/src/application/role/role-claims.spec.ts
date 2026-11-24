import { type AssignedRole } from '../../domain/role/role';
import { backofficeGrants } from './role-claims';

const assigned = (change: Partial<AssignedRole>): AssignedRole => ({
  code: 'cleaning_supervisor',
  scopeType: 'domain',
  scopeId: 'cleaning',
  requiresMfa: true,
  backofficeAccess: true,
  zoneKeys: [],
  permissions: [],
  ...change,
});

describe('droits écrits dans le jeton d’une session du back-office', () => {
  it('rôles avec leur portée, zones comprises, et permissions effectives', () => {
    const grants = backofficeGrants([
      assigned({ permissions: ['cleaning.catalog.read', 'cleaning.request.read'] }),
      assigned({
        code: 'cleaning_planner',
        scopeType: 'zone',
        scopeId: null,
        zoneKeys: ['porto-novo'],
        permissions: ['cleaning.planning.manage', 'cleaning.catalog.read'],
      }),
    ]);
    expect(grants.roles).toEqual([
      { role: 'customer', scopeType: 'personal' },
      { role: 'cleaning_supervisor', scopeType: 'domain', scopeId: 'cleaning' },
      { role: 'cleaning_planner', scopeType: 'zone', scopeId: null, zoneKeys: ['porto-novo'] },
    ]);
    expect(grants.perms).toEqual(['cleaning.catalog.read', 'cleaning.request.read']);
    expect(grants.zonePerms).toEqual({ 'porto-novo': ['cleaning.planning.manage'] });
  });

  it('un compte sans permission a des listes vides', () => {
    expect(backofficeGrants([assigned({})])).toMatchObject({ perms: [], zonePerms: {} });
  });
});
