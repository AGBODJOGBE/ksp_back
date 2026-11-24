import {
  type AssignedRole,
  backofficeRoles,
  catalogProblems,
  defaultAssignmentScope,
  FIELD_ROLES,
  INITIAL_BACKOFFICE_ROLES,
  RECOVERY_ROLES,
  ROLE_CATALOG,
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

describe('rôles du Recouvrement (ADR-060, migration 0011)', () => {
  it('superviseur et juriste au back-office ; huissier et avocat partenaires, sans back-office', () => {
    const byCode = new Map(RECOVERY_ROLES.map((r) => [r.code, r]));
    expect([...byCode.keys()].sort()).toEqual([
      'legal_officer',
      'recovery_bailiff',
      'recovery_lawyer',
      'recovery_supervisor',
    ]);
    expect(byCode.get('recovery_supervisor')).toMatchObject({ backofficeAccess: true, requiresMfa: true });
    expect(byCode.get('legal_officer')).toMatchObject({ backofficeAccess: true, requiresMfa: true });
    expect(byCode.get('recovery_bailiff')).toMatchObject({ backofficeAccess: false, requiresMfa: false });
    expect(byCode.get('recovery_lawyer')).toMatchObject({ backofficeAccess: false, requiresMfa: false });
    expect(RECOVERY_ROLES.every((r) => r.service === 'recovery' && r.scopeType === 'domain')).toBe(true);
  });

  it('le catalogue complet respecte les règles et n’a aucun code en double', () => {
    expect(catalogProblems(ROLE_CATALOG)).toEqual([]);
    expect(ROLE_CATALOG).toHaveLength(12);
  });
});

describe('catalogue initial des rôles du back-office', () => {
  it('contient les sept rôles du back-office du lot 2', () => {
    expect(INITIAL_BACKOFFICE_ROLES.map((r) => r.code).sort()).toEqual([
      'cleaning_admin',
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

  it('cleaning_agent est un rôle de terrain : ni back-office ni double authentification (R-RB-07)', () => {
    expect(FIELD_ROLES).toEqual([
      {
        service: 'cleaning',
        code: 'cleaning_agent',
        scopeType: 'domain',
        requiresMfa: false,
        backofficeAccess: false,
        description: 'Agent de terrain du nettoyage',
      },
    ]);
    expect(defaultAssignmentScope(FIELD_ROLES[0]!)).toEqual({ scopeType: 'domain', scopeId: 'cleaning' });
    expect(INITIAL_BACKOFFICE_ROLES.some((r) => r.code === 'cleaning_agent')).toBe(false);
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
    zoneKeys: [],
    permissions: [],
  });

  it('seuls les rôles du back-office l’ouvrent', () => {
    expect(backofficeRoles([assigned('seller', false)])).toEqual([]);
    expect(backofficeRoles([assigned('seller', false), assigned('cleaning_agent', true)])).toEqual([
      assigned('cleaning_agent', true),
    ]);
  });
});
