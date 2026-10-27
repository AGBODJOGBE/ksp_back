import { identityV1 } from '@ksp/contracts';
import { runWithContext } from '@ksp/platform';
import { GetUsersUseCase, type UserDirectory } from '../../application/directory/get-users.use-case';
import { type Account } from '../../application/session/session.ports';
import { IdentityGrpcController } from './identity.controller';

const ID = '0192f1c4-0000-7000-8000-000000000001';

const account: Account = {
  id: ID,
  status: 'active',
  firstName: 'Koffi',
  lastName: null,
  phoneE164: '+2290197000045',
  email: null,
  emailVerifiedAt: null,
  preferredLanguage: 'fr',
  createdAt: new Date('2026-10-19T12:00:00Z'),
};

const directory: UserDirectory = {
  findByIds: async (ids) => (ids.includes(ID) ? [account] : []),
};

const controller = new IdentityGrpcController(new GetUsersUseCase(directory));

const asCaller = <T>(callerService: string, fn: () => Promise<T>) =>
  runWithContext({ correlationId: 'c', callerService }, fn);

describe('IdentityGrpcController', () => {
  it('GetUser rend le compte au format du contrat, pour notification', async () => {
    const response = await asCaller('notification', () => controller.getUser({ userId: ID }));
    expect(response).toEqual({
      user: {
        id: ID,
        status: identityV1.UserStatus.USER_STATUS_ACTIVE,
        firstName: 'Koffi',
        lastName: '',
        phoneE164: '+2290197000045',
        email: '',
        preferredLanguage: 'fr',
        createdAt: '2026-10-19T12:00:00.000Z',
        emailVerified: false,
      },
    });
  });

  it('GetUsersByIds omet les comptes introuvables', async () => {
    const response = await asCaller('notification', () =>
      controller.getUsersByIds({ userIds: [ID, '0192f1c4-0000-7000-8000-0000000000ff'] }),
    );
    expect(response.users.map((user) => user.id)).toEqual([ID]);
  });

  it('refuse un service appelant non autorisé', async () => {
    await expect(asCaller('gateway', () => controller.getUser({ userId: ID }))).rejects.toMatchObject({
      code: 'IDENTITY_CALLER_FORBIDDEN',
    });
  });

  it('les autres méthodes restent indisponibles', async () => {
    await expect(controller.checkPermission()).rejects.toMatchObject({ code: 'IDENTITY_NOT_IMPLEMENTED' });
  });
});
