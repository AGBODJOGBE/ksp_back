import { identityV1 } from '@ksp/contracts';
import { runWithContext } from '@ksp/platform';
import {
  type GetMeUseCase,
  type Profile,
  type UpdateMeInput,
  type UpdateMeUseCase,
} from '../../application/account/account.use-cases';
import {
  type CancelDeletionUseCase,
  type RequestDeletionUseCase,
} from '../../application/deletion/account-deletion.use-cases';
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
  activeContext: { type: 'individual', organizationId: null, organizationName: null },
  deletion: null,
};

const REQUESTED_AT = new Date('2026-11-05T10:00:00Z');
const SCHEDULED_FOR = new Date('2026-12-05T10:00:00Z');

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
  const deletionRequests: string[] = [];
  const cancellations: { userId: string; sessionId: string }[] = [];
  const requestDeletion = {
    execute: async (userId: string) => {
      deletionRequests.push(userId);
      return { requestedAt: REQUESTED_AT, scheduledFor: SCHEDULED_FOR, postponedBy: [] };
    },
  } as unknown as RequestDeletionUseCase;
  const cancelDeletion = {
    execute: async (input: { userId: string; sessionId: string }) => {
      cancellations.push(input);
      return {
        account: profile.account,
        profileIncomplete: false,
        activeContext: profile.activeContext,
        accessToken: 'jeton-complet',
        accessTokenExpiresAt: new Date('2026-11-05T10:15:00Z'),
      };
    },
  } as unknown as CancelDeletionUseCase;
  return {
    reads,
    updates,
    emailChanges,
    confirmations,
    deletionRequests,
    cancellations,
    account: new AccountGrpcController(
      getMe,
      updateMe,
      changeEmail,
      confirmEmail,
      requestDeletion,
      cancelDeletion,
    ),
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
      activeContext: {
        type: identityV1.ContextType.CONTEXT_TYPE_INDIVIDUAL,
        organizationId: '',
        organizationName: '',
      },
    });
  });

  it('rend le type entreprise et l’organisation quand le profil vient d’un contexte d’organisation', async () => {
    const organizationId = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e20';
    const { account } = controller();
    profile.activeContext = { type: 'business', organizationId, organizationName: 'SARL Bénin Propre' };
    try {
      const response = await runWithContext({ correlationId: 'c', user }, () => account.getMe());
      expect(response.activeContext).toEqual({
        type: identityV1.ContextType.CONTEXT_TYPE_BUSINESS,
        organizationId,
        organizationName: 'SARL Bénin Propre',
      });
    } finally {
      profile.activeContext = { type: 'individual', organizationId: null, organizationName: null };
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
      organizationName: '',
    });
  });

  it('rend la suppression demandée dans le profil d’un compte en attente', async () => {
    const { account } = controller();
    profile.deletion = {
      requestedAt: REQUESTED_AT,
      scheduledFor: SCHEDULED_FOR,
      postponedBy: [
        { service: 'billing', kind: 'unpaid_invoice', reference: 'FAC-2026-000042', description: 'Facture' },
      ],
    };
    try {
      const response = await runWithContext({ correlationId: 'c', user }, () => account.getMe());
      expect(response.deletion).toEqual({
        requestedAt: '2026-11-05T10:00:00.000Z',
        scheduledFor: '2026-12-05T10:00:00.000Z',
        postponedBy: [
          {
            service: 'billing',
            kind: 'unpaid_invoice',
            reference: 'FAC-2026-000042',
            description: 'Facture',
          },
        ],
      });
    } finally {
      profile.deletion = null;
    }
  });

  it('demande la suppression du compte de l’utilisateur du jeton', async () => {
    const { deletionRequests, account } = controller();
    const response = await runWithContext({ correlationId: 'c', user }, () => account.requestDeletion());
    expect(deletionRequests).toEqual(['u-1']);
    expect(response).toEqual({
      deletion: {
        requestedAt: '2026-11-05T10:00:00.000Z',
        scheduledFor: '2026-12-05T10:00:00.000Z',
        postponedBy: [],
      },
    });
  });

  it('annule la suppression pour la session du jeton et rend un jeton complet', async () => {
    const { cancellations, account } = controller();
    const response = await runWithContext({ correlationId: 'c', user }, () => account.cancelDeletion());
    expect(cancellations).toEqual([{ userId: 'u-1', sessionId: 's-1' }]);
    expect(response).toMatchObject({
      accessToken: 'jeton-complet',
      accessTokenExpiresAt: '2026-11-05T10:15:00.000Z',
      profileIncomplete: false,
      user: { id: 'u-1', status: identityV1.UserStatus.USER_STATUS_ACTIVE },
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
    await expect(account.requestDeletion()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(account.cancelDeletion()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(reads).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });
});
