import { identityV1 } from '@ksp/contracts';
import { type RequestContext, runWithContext } from '@ksp/platform';
import { FindAccountByPhoneUseCase } from '../../application/account-admin/find-account-by-phone.use-case';
import { AccountAdminGrpcController } from './account-admin.controller';

const ID = '0192f1c4-0000-7000-8000-000000000001';

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> => {
  const context: RequestContext = {
    correlationId: 'c',
    user: {
      userId: '0192f1c4-0000-7000-8000-0000000000aa',
      sessionId: 's',
      activeContext: 'personal',
      roles: [{ role: 'cleaning_admin', scopeType: 'global' }],
      mfa: true,
      authTime: Math.floor(Date.now() / 1000),
    },
  };
  return runWithContext(context, fn);
};

describe('AccountAdminGrpcController', () => {
  it('FindAccountByPhone : compte au format du contrat, nom vide si le profil est incomplet', async () => {
    const controller = new AccountAdminGrpcController(
      new FindAccountByPhoneUseCase({
        findByPhone: async () => ({
          id: ID,
          status: 'active',
          firstName: 'Awa',
          lastName: null,
          phoneE164: '+2290197000045',
          email: null,
          emailVerifiedAt: null,
          preferredLanguage: 'fr',
          createdAt: new Date('2026-10-19T12:00:00Z'),
        }),
      }),
    );
    await expect(
      asAdmin(() => controller.findAccountByPhone({ phoneE164: '+2290197000045' })),
    ).resolves.toEqual({
      account: {
        userId: ID,
        status: identityV1.UserStatus.USER_STATUS_ACTIVE,
        firstName: 'Awa',
        lastName: '',
        phoneMasked: '+229********45',
      },
    });
  });
});
