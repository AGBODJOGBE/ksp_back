import { identityV1 } from '@ksp/contracts';
import { runWithContext } from '@ksp/platform';
import {
  type GetMeUseCase,
  type Profile,
  type UpdateMeInput,
  type UpdateMeUseCase,
} from '../../application/account/account.use-cases';
import {
  type ChangeEmailInput,
  type ChangeEmailUseCase,
} from '../../application/email/change-email.use-case';
import {
  type ConfirmEmailInput,
  type ConfirmEmailUseCase,
} from '../../application/email/confirm-email.use-case';
import { AccountGrpcController } from './account.controller';

const profile: Profile = {
  account: {
    id: 'u-1',
    status: 'active',
    firstName: 'Koffi',
    lastName: null,
    phoneE164: '+2290197000045',
    email: null,
    emailVerifiedAt: null,
    preferredLanguage: 'fr',
    createdAt: new Date('2026-10-19T12:00:00Z'),
  },
  profileIncomplete: true,
  pendingEmail: 'koffi@exemple.com',
  activeContext: { type: 'individual', organizationId: null },
};

function controller() {
  const reads: { userId: string; activeContext: string }[] = [];
  const updates: UpdateMeInput[] = [];
  const getMe = {
    execute: async (userId: string, activeContext: string) => {
      reads.push({ userId, activeContext });
      return profile;
    },
  } as unknown as GetMeUseCase;
  const updateMe = {
    execute: async (input: UpdateMeInput) => {
      updates.push(input);
      return profile;
    },
  } as unknown as UpdateMeUseCase;
  const emailChanges: ChangeEmailInput[] = [];
  const confirmations: ConfirmEmailInput[] = [];
  const changeEmail = {
    execute: async (input: ChangeEmailInput) => {
      emailChanges.push(input);
      return { pendingEmail: 'koffi@exemple.com', expiresInSeconds: 900, resendAfterSeconds: 60 };
    },
  } as unknown as ChangeEmailUseCase;
  const confirmEmail = {
    execute: async (input: ConfirmEmailInput) => {
      confirmations.push(input);
      return {
        ...profile,
        account: { ...profile.account, email: 'koffi@exemple.com', emailVerifiedAt: new Date() },
        pendingEmail: null,
      };
    },
  } as unknown as ConfirmEmailUseCase;
  return {
    reads,
    updates,
    emailChanges,
    confirmations,
    account: new AccountGrpcController(getMe, updateMe, changeEmail, confirmEmail),
  };
}

const user = { userId: 'u-1', sessionId: 's-1', activeContext: 'personal', roles: [], mfa: false };

describe('AccountGrpcController', () => {
  it('lit le profil de l’utilisateur du jeton, au format du contrat', async () => {
    const { reads, account } = controller();
    const response = await runWithContext({ correlationId: 'c', user }, () => account.getMe());
    expect(reads).toEqual([{ userId: 'u-1', activeContext: 'personal' }]);
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
        emailVerified: false,
      },
      profileIncomplete: true,
      pendingEmail: 'koffi@exemple.com',
      activeContext: { type: identityV1.ContextType.CONTEXT_TYPE_INDIVIDUAL, organizationId: '' },
    });
  });

  it('rend le type entreprise et l’organisation quand le profil vient d’un contexte d’organisation', async () => {
    const organizationId = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e20';
    const { account } = controller();
    profile.activeContext = { type: 'business', organizationId };
    try {
      const response = await runWithContext({ correlationId: 'c', user }, () => account.getMe());
      expect(response.activeContext).toEqual({
        type: identityV1.ContextType.CONTEXT_TYPE_BUSINESS,
        organizationId,
      });
    } finally {
      profile.activeContext = { type: 'individual', organizationId: null };
    }
  });

  it('modifie le compte de l’utilisateur du jeton, et seulement les champs envoyés', async () => {
    const { updates, account } = controller();
    await runWithContext({ correlationId: 'c', user }, () => account.updateMe({ lastName: 'Adjovi' }));
    expect(updates).toEqual([
      {
        userId: 'u-1',
        activeContext: 'personal',
        firstName: undefined,
        lastName: 'Adjovi',
        preferredLanguage: undefined,
      },
    ]);
  });

  it('déclare l’e-mail du compte de l’utilisateur du jeton, avec l’adresse IP du client', async () => {
    const { emailChanges, account } = controller();
    const response = await runWithContext({ correlationId: 'c', user, client: { ip: '196.192.10.4' } }, () =>
      account.changeEmail({ email: 'koffi@exemple.com' }),
    );
    expect(emailChanges).toEqual([{ userId: 'u-1', email: 'koffi@exemple.com', ip: '196.192.10.4' }]);
    expect(response).toEqual({
      pendingEmail: 'koffi@exemple.com',
      expiresInSeconds: 900,
      resendAfterSeconds: 60,
    });
  });

  it('confirme l’e-mail du compte de l’utilisateur du jeton et rend le profil vérifié', async () => {
    const { confirmations, account } = controller();
    const response = await runWithContext({ correlationId: 'c', user }, () =>
      account.confirmEmail({ code: '482913' }),
    );
    expect(confirmations).toEqual([{ userId: 'u-1', code: '482913', activeContext: 'personal' }]);
    expect(response.user).toMatchObject({ email: 'koffi@exemple.com', emailVerified: true });
    expect(response.activeContext).toEqual({
      type: identityV1.ContextType.CONTEXT_TYPE_INDIVIDUAL,
      organizationId: '',
    });
  });

  it('refuse un appel sans utilisateur connecté', async () => {
    const { reads, updates, account } = controller();
    await expect(account.getMe()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(account.updateMe({ firstName: 'Koffi' })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(account.changeEmail({ email: 'koffi@exemple.com' })).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    await expect(account.confirmEmail({ code: '482913' })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(reads).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });
});
