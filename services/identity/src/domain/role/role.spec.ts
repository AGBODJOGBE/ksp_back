import {
  type AssignedRole,
  backofficeRoles,
  catalogProblems,
  defaultAssignmentScope,
  INITIAL_BACKOFFICE_ROLES,
  type RoleDefinition,
} from './role';

const role = (change: Partial<RoleDefinition> = {}): RoleDefinition => ({
  service: 'cleaning',
  code: 'cleaning_agent',
  scopeType: 'domain',
  requiresMfa: true,
  backofficeAccess: true,
  description: 'Agent',
  ...change,
});

describe('catalogue initial des rôles du back-office', () => {
  it('contient les huit rôles du lot 2', () => {
    expect(INITIAL_BACKOFFICE_ROLES.map((r) => r.code).sort()).toEqual([
      'cleaning_admin',
      'cleaning_agent',
      'cleaning_supervisor',
      'finance_officer',
      'recovery_admin',
      'recovery_agent',
      'super_admin',
      'support_agent',
    ]);
  });

  it('respecte les règles : tous exigent la double authentification', () => {
    expect(catalogProblems(INITIAL_BACKOFFICE_ROLES)).toEqual([]);
    expect(INITIAL_BACKOFFICE_ROLES.every((r) => r.requiresMfa && r.backofficeAccess)).toBe(true);
  });

  it('super_admin est global ; un rôle de métier a la portée de son service', () => {
    const byCode = new Map(INITIAL_BACKOFFICE_ROLES.map((r) => [r.code, r]));
    expect(defaultAssignmentScope(byCode.get('super_admin')!)).toEqual({
      scopeType: 'global',
      scopeId: null,
    });
    expect(defaultAssignmentScope(byCode.get('cleaning_supervisor')!)).toEqual({
      scopeType: 'domain',
      scopeId: 'cleaning',
    });
    expect(defaultAssignmentScope(byCode.get('finance_officer')!)).toEqual({
      scopeType: 'domain',
      scopeId: 'wallet',
    });
  });

  it('une portée d’organisation ne s’attribue pas sans organisation', () => {
    expect(defaultAssignmentScope(role({ scopeType: 'org' }))).toBeNull();
  });
});

describe('règles d’un catalogue', () => {
  it.each([
    ['un rôle du back-office sans double authentification', [role({ requiresMfa: false })], 'sans double'],
    ['un code en double', [role(), role()], 'en double'],
    ['un code mal formé', [role({ code: 'Cleaning-Agent' })], 'code invalide'],
    ['un rôle personnel au back-office', [role({ scopeType: 'personal' })], 'personnel'],
  ])('refuse %s', (_label, roles, problem) => {
    expect(catalogProblems(roles).join('\n')).toContain(problem);
  });

  it('accepte un rôle hors back-office sans double authentification (vendeur)', () => {
    expect(catalogProblems([role({ code: 'seller', requiresMfa: false, backofficeAccess: false })])).toEqual(
      [],
    );
  });
});

describe('accès au back-office', () => {
  const assigned = (code: string, backofficeAccess: boolean): AssignedRole => ({
    code,
    scopeType: 'domain',
    scopeId: 'cleaning',
    requiresMfa: backofficeAccess,
    backofficeAccess,
  });

  it('seuls les rôles du back-office l’ouvrent', () => {
    expect(backofficeRoles([assigned('seller', false)])).toEqual([]);
    expect(backofficeRoles([assigned('seller', false), assigned('cleaning_agent', true)])).toEqual([
      assigned('cleaning_agent', true),
    ]);
  });
});
