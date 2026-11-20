import { AppError } from '@ksp/platform';
import { InMemoryRoles } from '../testing/mfa-fakes';
import { type StaffDirectory } from './rbac.ports';
import {
  CheckPermissionUseCase,
  GrantRoleUseCase,
  ListStaffByPermissionUseCase,
  RevokeRoleUseCase,
} from './service-roles.use-cases';

const AGENT = '0192f1c4-0000-7000-8000-00000000a001';
const SUPERVISOR = '0192f1c4-0000-7000-8000-00000000a002';

/** Annuaire du personnel tiré des doublures de rôles. */
class FakeStaff implements StaffDirectory {
  readonly status = new Map<string, string>([
    [AGENT, 'active'],
    [SUPERVISOR, 'active'],
  ]);
  constructor(private readonly roles: InMemoryRoles) {}
  async staffWith(): Promise<string[]> {
    return [SUPERVISOR];
  }
  async accountStatus(userId: string): Promise<string | null> {
    return this.status.get(userId) ?? null;
  }
  async assignment(id: string) {
    const found = this.roles.assignments.find((assignment) => assignment.id === id);
    return found
      ? { userId: found.userId, roleCode: found.role.code, revoked: found.revokedAt !== null }
      : null;
  }
}

function setup() {
  let seq = 0;
  const ids = { next: () => `0192f1c4-0000-7000-8000-${String(++seq).padStart(12, '0')}` };
  const clock = { now: () => new Date('2026-11-20T10:00:00Z') };
  const roles = new InMemoryRoles();
  const staff = new FakeStaff(roles);
  return {
    roles,
    staff,
    grant: new GrantRoleUseCase(roles, staff, ids, clock),
    revoke: new RevokeRoleUseCase(roles, staff, ids, clock),
    list: new ListStaffByPermissionUseCase(staff),
    check: new CheckPermissionUseCase(roles, staff),
  };
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof AppError)) throw new Error(`AppError attendue, reçu ${String(error)}`);
  return error;
}

describe('GrantRole et RevokeRole par un service (R-AG-01)', () => {
  it('cleaning attribue cleaning_agent, tracé avec le service pour auteur ; rejouable', async () => {
    const { grant, roles } = setup();
    const first = await grant.execute('cleaning', {
      userId: AGENT,
      roleCode: 'cleaning_agent',
      reason: 'Agent validé',
    });
    expect(first).toMatchObject({
      roleCode: 'cleaning_agent',
      scopeType: 'domain',
      scopeId: 'cleaning',
      created: true,
    });
    expect(roles.audit[0]).toMatchObject({ actorId: 'cleaning', action: 'user.role_granted' });
    const again = await grant.execute('cleaning', {
      userId: AGENT,
      roleCode: 'cleaning_agent',
      reason: 'Agent validé',
    });
    expect(again).toMatchObject({ assignmentId: first.assignmentId, created: false });
  });

  it('un autre rôle ou un autre service est refusé', async () => {
    const { grant } = setup();
    const role = await failure(
      grant.execute('cleaning', { userId: AGENT, roleCode: 'cleaning_admin', reason: 'x' }),
    );
    expect(role.code).toBe('IDENTITY_ROLE_FORBIDDEN');
    const caller = await failure(
      grant.execute('billing', { userId: AGENT, roleCode: 'cleaning_agent', reason: 'x' }),
    );
    expect(caller.code).toBe('IDENTITY_CALLER_FORBIDDEN');
  });

  it('compte inconnu ou non actif, rôle désactivé', async () => {
    const { grant, staff, roles } = setup();
    const unknown = await failure(
      grant.execute('cleaning', {
        userId: '0192f1c4-0000-7000-8000-00000000ffff',
        roleCode: 'cleaning_agent',
        reason: 'x',
      }),
    );
    expect(unknown.code).toBe('IDENTITY_USER_NOT_FOUND');
    staff.status.set(AGENT, 'suspended');
    const suspended = await failure(
      grant.execute('cleaning', { userId: AGENT, roleCode: 'cleaning_agent', reason: 'x' }),
    );
    expect(suspended).toMatchObject({
      code: 'IDENTITY_ACCOUNT_NOT_ACTIVE',
      details: { status: 'suspended' },
    });
    staff.status.set(AGENT, 'active');
    roles.definitions.find((role) => role.code === 'cleaning_agent')!.active = false;
    const inactive = await failure(
      grant.execute('cleaning', { userId: AGENT, roleCode: 'cleaning_agent', reason: 'x' }),
    );
    expect(inactive.code).toBe('IDENTITY_ROLE_INACTIVE');
  });

  it('cleaning retire le rôle qu’il a donné ; rejouer ne fait rien de plus', async () => {
    const { grant, revoke, roles } = setup();
    const { assignmentId } = await grant.execute('cleaning', {
      userId: AGENT,
      roleCode: 'cleaning_agent',
      reason: 'Agent validé',
    });
    await revoke.execute('cleaning', { assignmentId, reason: 'Agent désactivé' });
    await revoke.execute('cleaning', { assignmentId, reason: 'Agent désactivé' });
    expect(roles.revoked).toHaveLength(1);
    expect(roles.audit.at(-1)).toMatchObject({ actorId: 'cleaning', action: 'user.role_revoked' });
  });
});

describe('ListStaffByPermission et CheckPermission', () => {
  it('notification seul lit le personnel', async () => {
    const { list } = setup();
    expect(
      await list.execute('notification', { permission: 'cleaning.request.process', zoneKey: 'cotonou' }),
    ).toEqual([SUPERVISOR]);
    const error = await failure(
      list.execute('cleaning', { permission: 'cleaning.request.process', zoneKey: '' }),
    );
    expect(error.code).toBe('IDENTITY_CALLER_FORBIDDEN');
  });

  it('permission partout, dans la zone demandée seulement, ou absente', async () => {
    const { check, roles } = setup();
    roles.permissionsOf.set('cleaning_supervisor', ['cleaning.request.process']);
    roles.assignments.push({
      id: 'a-zone',
      userId: SUPERVISOR,
      role: roles.definitions.find((role) => role.code === 'cleaning_supervisor')!,
      scopeType: 'zone',
      scopeId: null,
      zoneKeys: ['porto-novo'],
      grantedBy: null,
      grantedAt: new Date(),
      grantReason: null,
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
    });
    const input = { userId: SUPERVISOR, permission: 'cleaning.request.process' };
    expect(await check.execute({ ...input, scopeType: 'zone', scopeId: 'porto-novo' })).toEqual({
      allowed: true,
      reason: '',
    });
    expect(await check.execute({ ...input, scopeType: 'zone', scopeId: 'cotonou' })).toEqual({
      allowed: false,
      reason: 'permission_missing',
    });
    expect(await check.execute({ ...input, scopeType: 'global', scopeId: '' })).toMatchObject({
      allowed: false,
    });
  });
});
