import { type AppError, type RequestContext, runWithContext } from '@ksp/platform';
import { type Account } from '../session/session.ports';
import { FindAccountByPhoneUseCase } from './find-account-by-phone.use-case';

const ID = '0192f1c4-0000-7000-8000-000000000001';

const account = (overrides: Partial<Account> = {}): Account => ({
  id: ID,
  status: 'active',
  firstName: 'Awa',
  lastName: 'Bio',
  phoneE164: '+2290197000045',
  email: 'awa@example.com',
  emailVerifiedAt: new Date('2026-10-20T09:00:00Z'),
  preferredLanguage: 'fr',
  createdAt: new Date('2026-10-19T12:00:00Z'),
  ...overrides,
});

function asStaff<T>(roles: string[], fn: () => Promise<T>, mfa = true): Promise<T> {
  const context: RequestContext = {
    correlationId: 'c',
    user: {
      userId: '0192f1c4-0000-7000-8000-0000000000aa',
      sessionId: 's',
      activeContext: 'personal',
      roles: roles.map((role) => ({ role, scopeType: 'global' as const })),
      mfa,
      authTime: Math.floor(Date.now() / 1000),
    },
  };
  return runWithContext(context, fn);
}

function useCase(found: Account | null = account()) {
  const lookups: string[] = [];
  const lookup = new FindAccountByPhoneUseCase({
    findByPhone: async (phone) => {
      lookups.push(phone);
      return found;
    },
  });
  return { lookups, lookup };
}

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error: AppError) => error.code,
  );

describe('FindAccountByPhoneUseCase (recherche de compte au back-office)', () => {
  it('rend identifiant, nom et numéro masqué, jamais l’e-mail ni le numéro complet', async () => {
    const { lookup, lookups } = useCase();
    const match = await asStaff(['cleaning_admin'], () => lookup.execute({ phone: '+229 01 97 00 00 45' }));
    expect(match).toEqual({
      userId: ID,
      status: 'active',
      firstName: 'Awa',
      lastName: 'Bio',
      phoneMasked: '+229********45',
    });
    expect(lookups).toEqual(['+2290197000045']);
    expect(JSON.stringify(match)).not.toContain('awa@example.com');
  });

  it('super_admin a la même portée ; double authentification exigée ; autres rôles refusés', async () => {
    const { lookup, lookups } = useCase();
    const find = () => lookup.execute({ phone: '+2290197000045' });
    expect(await code(asStaff(['super_admin'], find))).toBe('ok');
    expect(await code(asStaff(['cleaning_admin'], find, false))).toBe('AUTH_MFA_REQUIRED');
    expect(await code(asStaff(['cleaning_supervisor'], find))).toBe('AUTH_FORBIDDEN');
    expect(await code(asStaff(['customer'], find))).toBe('AUTH_FORBIDDEN');
    expect(lookups).toHaveLength(1);
  });

  it('numéro invalide, compte inconnu ou supprimé', async () => {
    expect(
      await code(asStaff(['cleaning_admin'], () => useCase().lookup.execute({ phone: '0197000045' }))),
    ).toBe('IDENTITY_PHONE_INVALID');
    expect(
      await code(
        asStaff(['cleaning_admin'], () => useCase(null).lookup.execute({ phone: '+2290197000045' })),
      ),
    ).toBe('IDENTITY_USER_NOT_FOUND');
    expect(
      await code(
        asStaff(['cleaning_admin'], () =>
          useCase(account({ status: 'deleted' })).lookup.execute({ phone: '+2290197000045' }),
        ),
      ),
    ).toBe('IDENTITY_USER_NOT_FOUND');
  });
});
