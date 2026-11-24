import { AppError, type RequestContext, runWithContext } from '@ksp/platform';
import { InMemoryRbac } from '../testing/rbac-fakes';
import { GetCatalogUseCase, ListPermissionsUseCase, RegisterCatalogUseCase } from './catalog.use-cases';
import {
  CreateRoleUseCase,
  DeactivateRoleUseCase,
  GetRoleUseCase,
  UpdateRoleUseCase,
} from './managed-roles.use-cases';

const DIRECTOR = '0192f1c4-0000-7000-8000-00000000ad01';
const REASON = 'Nouvelle organisation du planning';

function setup() {
  let seq = 0;
  const ids = { next: () => `0192f1c4-0000-7000-8000-${String(++seq).padStart(12, '0')}` };
  const clock = { now: () => new Date('2026-11-20T10:00:00Z') };
  const rbac = new InMemoryRbac();
  rbac.addRole({ code: 'super_admin', sensitive: true });
  ['cleaning.request.read', 'cleaning.planning.manage', 'cleaning.catalog.manage'].forEach((code) =>
    rbac.declare(code),
  );
  rbac.declare('cleaning.legacy.read', true);
  return {
    rbac,
    register: new RegisterCatalogUseCase(rbac, ids, clock),
    getCatalog: new GetCatalogUseCase(rbac),
    listPermissions: new ListPermissionsUseCase(rbac),
    get: new GetRoleUseCase(rbac),
    create: new CreateRoleUseCase(rbac, ids, clock),
    update: new UpdateRoleUseCase(rbac, ids, clock),
    deactivate: new DeactivateRoleUseCase(rbac, ids, clock),
  };
}

function as<T>(roleCodes: string[], fn: () => Promise<T>, mfaAgeSeconds = 0): Promise<T> {
  const context: RequestContext = {
    correlationId: 'c',
    user: {
      userId: DIRECTOR,
      sessionId: 's',
      activeContext: 'personal',
      roles: roleCodes.map((role) => ({ role, scopeType: 'global' })),
      mfa: true,
      authTime: Math.floor(Date.now() / 1000) - mfaAgeSeconds,
    },
  };
  return runWithContext(context, fn);
}
const asDirector = <T>(fn: () => Promise<T>) => as(['customer', 'super_admin'], fn);

async function failure(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof AppError)) throw new Error(`AppError attendue, reçu ${String(error)}`);
  return error;
}

const planner = {
  code: 'cleaning_planner',
  name: 'Planificateur Nettoyage',
  description: 'Planifie les visites et les séances.',
  permissions: ['cleaning.planning.manage', 'cleaning.request.read'],
  sensitive: false,
  reason: REASON,
};

describe('RegisterCatalogUseCase (R-RB-01)', () => {
  const catalog = {
    service: 'cleaning',
    version: 2,
    permissions: [
      { code: 'cleaning.request.read', description: 'Lire les demandes' },
      { code: 'cleaning.zone.manage', description: 'Gérer les zones' },
    ],
    roles: [
      {
        code: 'cleaning_supervisor',
        name: 'Superviseur',
        description: 'Superviseur',
        scopeType: 'domain' as const,
        requiresMfa: true,
        backofficeAccess: true,
        sensitive: false,
        permissions: ['cleaning.request.read'],
      },
    ],
  };

  it('remplace le catalogue du service : ajoutées, retirées, rôles créés ; rejouable', async () => {
    const { register, rbac } = setup();
    expect(await register.execute('cleaning', catalog)).toEqual({
      permissionsAdded: 1,
      permissionsRetired: 2,
      rolesCreated: 1,
    });
    expect(rbac.permissionRows.get('cleaning.planning.manage')?.retired).toBe(true);
    // Même version : sans effet.
    expect(await register.execute('cleaning', catalog)).toEqual({
      permissionsAdded: 0,
      permissionsRetired: 0,
      rolesCreated: 0,
    });
  });

  it('un rôle modifié par un administrateur n’est jamais écrasé (R-RB-02)', async () => {
    const { register, rbac } = setup();
    rbac.addRole({
      code: 'cleaning_supervisor',
      name: 'Modifié par le super admin',
      permissions: ['cleaning.zone.manage'],
      updatedAt: new Date('2026-11-01T10:00:00Z'),
      updatedBy: '0192f1c4-0000-7000-8000-00000000ad01',
    });
    const result = await register.execute('cleaning', catalog);
    expect(result.rolesCreated).toBe(0);
    expect(rbac.roleRows.get('cleaning_supervisor')).toMatchObject({
      name: 'Modifié par le super admin',
      permissions: ['cleaning.zone.manage'],
    });
    expect(rbac.audit).toEqual([]);
  });

  it('un rôle par défaut jamais modifié reçoit les permissions déclarées pour lui, sans rien perdre', async () => {
    const { register, rbac } = setup();
    rbac.declare('wallet.cash.record');
    rbac.addRole({ code: 'cleaning_supervisor', name: 'Superviseur Nettoyage', permissions: [] });
    rbac.addRole({ code: 'finance_officer', service: 'wallet', permissions: ['wallet.cash.record'] });
    const shared = {
      ...catalog.roles[0]!,
      code: 'finance_officer',
      // La permission d'un autre service n'est jamais ajoutée par cleaning.
      permissions: ['cleaning.zone.manage', 'wallet.withdrawal.approve'],
    };
    const result = await register.execute('cleaning', { ...catalog, roles: [...catalog.roles, shared] });
    expect(result.rolesCreated).toBe(0);
    // Nom gardé, permissions ajoutées seulement.
    expect(rbac.roleRows.get('cleaning_supervisor')).toMatchObject({
      name: 'Superviseur Nettoyage',
      permissions: ['cleaning.request.read'],
    });
    expect(rbac.roleRows.get('finance_officer')?.permissions).toEqual([
      'cleaning.zone.manage',
      'wallet.cash.record',
    ]);
    // Tracé comme une écriture de rôle, avec le service pour auteur.
    expect(rbac.audit).toEqual([
      {
        actorId: 'cleaning',
        action: 'role.default_permissions_added',
        entityId: 'cleaning_supervisor',
        details: {
          permissionsAdded: ['cleaning.request.read'],
          before: [],
          after: ['cleaning.request.read'],
        },
      },
      {
        actorId: 'cleaning',
        action: 'role.default_permissions_added',
        entityId: 'finance_officer',
        details: {
          permissionsAdded: ['cleaning.zone.manage'],
          before: ['wallet.cash.record'],
          after: ['cleaning.zone.manage', 'wallet.cash.record'],
        },
      },
    ]);
    // Rejoué (même version, ou version suivante sans nouveauté) : sans effet.
    await register.execute('cleaning', { ...catalog, roles: [...catalog.roles, shared] });
    await register.execute('cleaning', { ...catalog, version: 3, roles: [...catalog.roles, shared] });
    expect(rbac.audit).toHaveLength(2);
  });

  it('un rôle créé au back-office, ou désactivé, n’est pas complété', async () => {
    const { register, rbac } = setup();
    rbac.addRole({ code: 'cleaning_supervisor', origin: 'custom', permissions: [] });
    await register.execute('cleaning', catalog);
    expect(rbac.roleRows.get('cleaning_supervisor')?.permissions).toEqual([]);
    const other = setup();
    other.rbac.addRole({ code: 'cleaning_supervisor', active: false, permissions: [] });
    await other.register.execute('cleaning', catalog);
    expect(other.rbac.roleRows.get('cleaning_supervisor')?.permissions).toEqual([]);
  });

  it('le service déclaré est celui du jeton : une permission d’un autre service est refusée', async () => {
    const { register } = setup();
    const error = await failure(register.execute('wallet', catalog));
    expect(error.code).toBe('IDENTITY_CATALOG_INVALID');
    expect(error.details).toEqual({ field: 'permissions.cleaning.request.read' });
  });

  it('refuse un code mal formé et un rôle du back-office sans double authentification', async () => {
    const { register } = setup();
    const badCode = { ...catalog, permissions: [{ code: 'cleaning.read', description: '' }] };
    expect((await failure(register.execute('cleaning', badCode))).code).toBe('IDENTITY_CATALOG_INVALID');
    const role = catalog.roles[0]!;
    const noMfa = { ...catalog, roles: [{ ...role, requiresMfa: false }] };
    expect((await failure(register.execute('cleaning', noMfa))).details).toEqual({
      field: 'roles.cleaning_supervisor',
    });
  });

  it('GetCatalog rend les permissions non retirées et les rôles du service', async () => {
    const { register, getCatalog } = setup();
    await register.execute('cleaning', catalog);
    const result = await getCatalog.execute('cleaning');
    expect(result.permissions.map((p) => p.code).sort()).toEqual([
      'cleaning.request.read',
      'cleaning.zone.manage',
    ]);
    expect(result.roles.map((r) => r.code)).toEqual(['cleaning_supervisor']);
  });
});

describe('ListPermissionsUseCase', () => {
  it('super_admin : triées par code, retirées sur demande', async () => {
    const { listPermissions } = setup();
    const active = await asDirector(() => listPermissions.execute({ service: '', includeRetired: false }));
    expect(active.map((p) => p.code)).toEqual([
      'cleaning.catalog.manage',
      'cleaning.planning.manage',
      'cleaning.request.read',
    ]);
    const all = await asDirector(() =>
      listPermissions.execute({ service: 'cleaning', includeRetired: true }),
    );
    expect(all.map((p) => p.code)).toContain('cleaning.legacy.read');
  });

  it('refusée à un autre rôle', async () => {
    const { listPermissions } = setup();
    const error = await failure(
      as(['customer', 'cleaning_admin'], () =>
        listPermissions.execute({ service: '', includeRetired: false }),
      ),
    );
    expect(error.code).toBe('AUTH_FORBIDDEN');
  });
});

describe('rôles gérés (R-RB-02, R-RB-04)', () => {
  it('crée un rôle personnalisé, actif, avec ses permissions triées ; événement publié', async () => {
    const { create, rbac } = setup();
    const role = await asDirector(() => create.execute(planner));
    expect(role).toMatchObject({
      code: 'cleaning_planner',
      origin: 'custom',
      active: true,
      editable: true,
      createdBy: DIRECTOR,
      permissions: ['cleaning.planning.manage', 'cleaning.request.read'],
    });
    expect(rbac.events).toEqual([
      { type: 'identity.role.created', payload: { roleCode: 'cleaning_planner' } },
    ]);
  });

  it('refuse un code pris, une permission inconnue ou retirée, une saisie invalide, un motif absent', async () => {
    const { create } = setup();
    await asDirector(() => create.execute(planner));
    expect((await failure(asDirector(() => create.execute(planner)))).code).toBe(
      'IDENTITY_ROLE_ALREADY_EXISTS',
    );
    const retired = await failure(
      asDirector(() => create.execute({ ...planner, code: 'other', permissions: ['cleaning.legacy.read'] })),
    );
    expect(retired.code).toBe('IDENTITY_PERMISSION_NOT_FOUND');
    expect(retired.details).toEqual({ codes: ['cleaning.legacy.read'] });
    const invalid = await failure(asDirector(() => create.execute({ ...planner, code: 'X' })));
    expect(invalid.details).toEqual({ field: 'code' });
    const noReason = await failure(
      asDirector(() => create.execute({ ...planner, code: 'other', reason: '' })),
    );
    expect(noReason.code).toBe('IDENTITY_ACCOUNT_ADMIN_INVALID');
  });

  it('écriture : double authentification de moins de 10 minutes', async () => {
    const { create } = setup();
    const error = await failure(as(['customer', 'super_admin'], () => create.execute(planner), 3600));
    expect(error.code).toBe('AUTH_MFA_REQUIRED');
  });

  it('modifie les permissions (liste complète) et publie l’ajout et le retrait', async () => {
    const { create, update, rbac } = setup();
    await asDirector(() => create.execute(planner));
    const role = await asDirector(() =>
      update.execute({
        code: 'cleaning_planner',
        permissions: ['cleaning.catalog.manage', 'cleaning.request.read'],
        reason: REASON,
      }),
    );
    expect(role.permissions).toEqual(['cleaning.catalog.manage', 'cleaning.request.read']);
    expect(role.updatedBy).toBe(DIRECTOR);
    expect(rbac.events.at(-1)).toEqual({
      type: 'identity.role.updated',
      payload: {
        roleCode: 'cleaning_planner',
        permissionsAdded: ['cleaning.catalog.manage'],
        permissionsRemoved: ['cleaning.planning.manage'],
      },
    });
  });

  it('super_admin n’est ni modifiable ni désactivable', async () => {
    const { update, deactivate, get } = setup();
    expect((await asDirector(() => get.execute('super_admin'))).editable).toBe(false);
    const updated = await failure(
      asDirector(() => update.execute({ code: 'super_admin', name: 'X', reason: REASON })),
    );
    expect(updated.code).toBe('IDENTITY_ROLE_NOT_EDITABLE');
    const deactivated = await failure(
      asDirector(() => deactivate.execute({ code: 'super_admin', reason: REASON })),
    );
    expect(deactivated.code).toBe('IDENTITY_ROLE_NOT_EDITABLE');
  });

  it('un rôle encore attribué ne se désactive pas ; libre, il se désactive et ne se modifie plus', async () => {
    const { create, update, deactivate, rbac } = setup();
    await asDirector(() => create.execute(planner));
    rbac.activeAssignments.set('cleaning_planner', 2);
    const inUse = await failure(
      asDirector(() => deactivate.execute({ code: 'cleaning_planner', reason: REASON })),
    );
    expect(inUse.code).toBe('IDENTITY_ROLE_IN_USE');
    expect(inUse.details).toEqual({ activeAssignments: 2 });

    rbac.activeAssignments.set('cleaning_planner', 0);
    const role = await asDirector(() => deactivate.execute({ code: 'cleaning_planner', reason: REASON }));
    expect(role).toMatchObject({ active: false, deactivatedBy: DIRECTOR });
    const inactive = await failure(
      asDirector(() => update.execute({ code: 'cleaning_planner', name: 'Y', reason: REASON })),
    );
    expect(inactive.code).toBe('IDENTITY_ROLE_INACTIVE');
  });

  it('rôle inconnu : IDENTITY_ROLE_NOT_FOUND', async () => {
    const { get } = setup();
    expect((await failure(asDirector(() => get.execute('unknown_role')))).code).toBe(
      'IDENTITY_ROLE_NOT_FOUND',
    );
  });
});
