import { identityV1 } from '@ksp/contracts';
import { runWithContext } from '@ksp/platform';
import {
  type GetMeUseCase,
  type Profile,
  type UpdateMeInput,
  type UpdateMeUseCase,
} from '../../application/account/account.use-cases';
import { AccountGrpcController } from './account.controller';

const profile: Profile = {
  account: {
    id: 'u-1',
    status: 'active',
    firstName: 'Koffi',
    lastName: null,
    phoneE164: '+2290197000045',
    email: null,
    preferredLanguage: 'fr',
    createdAt: new Date('2026-10-19T12:00:00Z'),
  },
  profileIncomplete: true,
};

function controller() {
  const reads: string[] = [];
  const updates: UpdateMeInput[] = [];
  const getMe = {
    execute: async (userId: string) => {
      reads.push(userId);
      return profile;
    },
  } as unknown as GetMeUseCase;
  const updateMe = {
    execute: async (input: UpdateMeInput) => {
      updates.push(input);
      return profile;
    },
  } as unknown as UpdateMeUseCase;
  return { reads, updates, account: new AccountGrpcController(getMe, updateMe) };
}

const user = { userId: 'u-1', sessionId: 's-1', activeContext: 'personal', roles: [], mfa: false };

describe('AccountGrpcController', () => {
  it('lit le profil de l’utilisateur du jeton, au format du contrat', async () => {
    const { reads, account } = controller();
    const response = await runWithContext({ correlationId: 'c', user }, () => account.getMe());
    expect(reads).toEqual(['u-1']);
    expect(response).toEqual({
      user: {
        id: 'u-1',
        status: identityV1.UserStatus.USER_STATUS_ACTIVE,
        firstName: 'Koffi',
        lastName: '',
        phoneE164: '+2290197000045',
        email: '',
        preferredLanguage: 'fr',
        createdAt: '2026-10-19T12:00:00.000Z',
      },
      profileIncomplete: true,
    });
  });

  it('modifie le compte de l’utilisateur du jeton, et seulement les champs envoyés', async () => {
    const { updates, account } = controller();
    await runWithContext({ correlationId: 'c', user }, () => account.updateMe({ lastName: 'Adjovi' }));
    expect(updates).toEqual([
      { userId: 'u-1', firstName: undefined, lastName: 'Adjovi', preferredLanguage: undefined },
    ]);
  });

  it('refuse un appel sans utilisateur connecté', async () => {
    const { reads, updates, account } = controller();
    await expect(account.getMe()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(account.updateMe({ firstName: 'Koffi' })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(reads).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });
});
