import { AppError } from '@ksp/platform';
import { InMemoryChallenges, InMemoryIdentityStore } from '../testing/fakes';
import { InMemoryRoles } from '../testing/mfa-fakes';
import { GrantRoleUseCase } from './grant-role.use-case';

function setup() {
  let seq = 0;
  const store = new InMemoryIdentityStore(new InMemoryChallenges());
  store.accounts.push({
    id: 'u-1',
    status: 'active',
    firstName: 'Koffi',
    lastName: 'Adjovi',
    phoneE164: '+2290197000045',
    email: null,
    emailVerifiedAt: null,
    preferredLanguage: 'fr',
    createdAt: new Date('2026-10-19T12:00:00Z'),
  });
  const roles = new InMemoryRoles();
  const useCase = new GrantRoleUseCase(
    store,
    roles,
    { next: () => `a-${++seq}` },
    {
      now: () => new Date('2026-10-22T09:00:00Z'),
    },
  );
  return { useCase, roles };
}

async function expectAppError(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
}

describe('GrantRoleUseCase (amorçage roles:grant)', () => {
  it('attribue un rôle de métier avec la portée du métier, une seule fois', async () => {
    const { useCase, roles } = setup();
    const first = await useCase.execute({ phone: '+229 01 97 00 00 45', roleCode: 'cleaning_supervisor' });
    expect(first).toEqual({
      assignmentId: 'a-1',
      userId: 'u-1',
      roleCode: 'cleaning_supervisor',
      scopeType: 'domain',
      scopeId: 'cleaning',
      created: true,
    });
    const again = await useCase.execute({ phone: '+2290197000045', roleCode: 'cleaning_supervisor' });
    expect(again).toMatchObject({ assignmentId: 'a-1', created: false });
    expect(roles.granted).toHaveLength(1);
  });

  it('un rôle global n’a pas de portée particulière', async () => {
    const { useCase } = setup();
    await expect(
      useCase.execute({ phone: '+2290197000045', roleCode: 'super_admin' }),
    ).resolves.toMatchObject({
      scopeType: 'global',
      scopeId: null,
    });
  });

  it('refuse un numéro invalide, un compte inconnu ou un rôle inconnu', async () => {
    const { useCase } = setup();
    await expectAppError(
      useCase.execute({ phone: '97000045', roleCode: 'super_admin' }),
      'IDENTITY_PHONE_INVALID',
    );
    await expectAppError(
      useCase.execute({ phone: '+2290197000046', roleCode: 'super_admin' }),
      'IDENTITY_USER_NOT_FOUND',
    );
    await expectAppError(
      useCase.execute({ phone: '+2290197000045', roleCode: 'pilote' }),
      'IDENTITY_ROLE_NOT_FOUND',
    );
  });
});
