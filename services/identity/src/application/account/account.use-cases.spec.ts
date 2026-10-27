import { AppError } from '@ksp/platform';
import { PERSONAL_CONTEXT } from '../../domain/context/active-context';
import { PendingEmails } from '../email/pending-email';
import { InMemoryChallenges, InMemoryEmailVerifications, InMemoryIdentityStore } from '../testing/fakes';
import { GetMeUseCase, UpdateMeUseCase } from './account.use-cases';

function setup() {
  const store = new InMemoryIdentityStore(new InMemoryChallenges());
  store.accounts.push({
    id: 'u-1',
    status: 'active',
    firstName: null,
    lastName: null,
    phoneE164: '+2290197000045',
    email: null,
    emailVerifiedAt: null,
    preferredLanguage: 'fr',
    createdAt: new Date('2026-10-19T12:00:00Z'),
  });
  const pending = new PendingEmails(
    new InMemoryEmailVerifications(store),
    { now: () => new Date('2026-10-27T12:00:00Z') },
    5,
  );
  return { store, getMe: new GetMeUseCase(store, pending), updateMe: new UpdateMeUseCase(store, pending) };
}

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  return error as AppError;
}

describe('GetMeUseCase', () => {
  it('renvoie le profil et signale qu’il reste à compléter', async () => {
    const { getMe } = setup();
    await expect(getMe.execute('u-1', PERSONAL_CONTEXT)).resolves.toMatchObject({
      account: { id: 'u-1', phoneE164: '+2290197000045', email: null },
      profileIncomplete: true,
      pendingEmail: null,
      activeContext: { type: 'individual', organizationId: null },
    });
  });

  it('une organisation active dans le jeton fait un compte entreprise', async () => {
    const { getMe } = setup();
    const organizationId = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e20';
    await expect(getMe.execute('u-1', organizationId)).resolves.toMatchObject({
      activeContext: { type: 'business', organizationId },
    });
  });

  it('un compte inconnu ou supprimé est introuvable', async () => {
    const { getMe, store } = setup();
    await expectAppError(getMe.execute('inconnu', PERSONAL_CONTEXT), 'IDENTITY_USER_NOT_FOUND');
    store.accounts[0].status = 'deleted';
    await expectAppError(getMe.execute('u-1', PERSONAL_CONTEXT), 'IDENTITY_USER_NOT_FOUND');
  });
});

describe('UpdateMeUseCase', () => {
  it('complète le nom, nettoyé, et le profil devient complet', async () => {
    const { updateMe } = setup();
    const profile = await updateMe.execute({
      userId: 'u-1',
      activeContext: PERSONAL_CONTEXT,
      firstName: '  Jean-Baptiste ',
      lastName: "N'Diaye",
    });
    expect(profile.account).toMatchObject({ firstName: 'Jean-Baptiste', lastName: "N'Diaye" });
    expect(profile.profileIncomplete).toBe(false);
    expect(profile.activeContext).toEqual({ type: 'individual', organizationId: null });
  });

  it('ne modifie que les champs envoyés', async () => {
    const { updateMe } = setup();
    await updateMe.execute({
      userId: 'u-1',
      activeContext: PERSONAL_CONTEXT,
      firstName: 'Koffi',
      lastName: 'Adjovi',
    });
    const profile = await updateMe.execute({
      userId: 'u-1',
      activeContext: PERSONAL_CONTEXT,
      preferredLanguage: 'EN',
    });
    expect(profile.account).toMatchObject({
      firstName: 'Koffi',
      lastName: 'Adjovi',
      preferredLanguage: 'en',
    });
  });

  it('refuse un nom avec des chiffres ou des symboles, en indiquant le champ', async () => {
    const { updateMe, store } = setup();
    const error = await expectAppError(
      updateMe.execute({
        userId: 'u-1',
        activeContext: PERSONAL_CONTEXT,
        firstName: 'Koffi',
        lastName: 'Adj0vi',
      }),
      'IDENTITY_NAME_INVALID',
    );
    expect(error.details).toEqual({ field: 'lastName' });
    expect(store.accounts[0].firstName).toBeNull();
  });

  it('refuse un nom vide', async () => {
    const { updateMe } = setup();
    await expectAppError(
      updateMe.execute({ userId: 'u-1', activeContext: PERSONAL_CONTEXT, firstName: '   ' }),
      'IDENTITY_NAME_INVALID',
    );
  });

  it('refuse une langue qui n’est pas un code de deux lettres', async () => {
    const { updateMe } = setup();
    await expectAppError(
      updateMe.execute({ userId: 'u-1', activeContext: PERSONAL_CONTEXT, preferredLanguage: 'français' }),
      'IDENTITY_LANGUAGE_INVALID',
    );
  });

  it('refuse une demande sans champ à modifier', async () => {
    const { updateMe } = setup();
    await expectAppError(
      updateMe.execute({ userId: 'u-1', activeContext: PERSONAL_CONTEXT }),
      'IDENTITY_PROFILE_EMPTY_UPDATE',
    );
  });

  it('un compte supprimé ne peut pas être modifié', async () => {
    const { updateMe, store } = setup();
    store.accounts[0].status = 'deleted';
    await expectAppError(
      updateMe.execute({ userId: 'u-1', activeContext: PERSONAL_CONTEXT, firstName: 'Koffi' }),
      'IDENTITY_USER_NOT_FOUND',
    );
    expect(store.accounts[0].firstName).toBeNull();
  });
});
