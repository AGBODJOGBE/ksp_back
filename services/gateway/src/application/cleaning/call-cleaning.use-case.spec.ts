import { AppError } from '@ksp/platform';
import { CallCleaningUseCase } from './call-cleaning.use-case';
import { type CleaningApi, type CleaningCall } from './cleaning.ports';

const call: CleaningCall = {
  params: {},
  query: {},
  body: { placeId: 'p-1' },
  idempotencyKey: 'cle-00000001',
  read: false,
};

function setup(profileIncomplete: boolean) {
  const calls: { operationId: string; call: CleaningCall }[] = [];
  const cleaning: CleaningApi = {
    call: async (operationId, input) => {
      calls.push({ operationId, call: input });
      return { ok: true };
    },
  };
  const identity = { getMe: jest.fn(async () => ({ profileIncomplete }) as never) };
  return { useCase: new CallCleaningUseCase(identity, cleaning), calls, identity };
}

describe('CallCleaningUseCase', () => {
  it('route sans exigence de profil : transmise telle quelle, identity jamais interrogé', async () => {
    const { useCase, calls, identity } = setup(true);
    await expect(useCase.execute({ operationId: 'cleaningListMyPlaces' }, call)).resolves.toEqual({
      ok: true,
    });
    expect(calls).toEqual([{ operationId: 'cleaningListMyPlaces', call }]);
    expect(identity.getMe).not.toHaveBeenCalled();
  });

  it('profil complet exigé et incomplet : 422 IDENTITY_PROFILE_INCOMPLETE, cleaning jamais appelé', async () => {
    const { useCase, calls } = setup(true);
    const error = await useCase
      .execute({ operationId: 'cleaningSubmitRequest', requiresCompleteProfile: true }, call)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ kind: 'FAILED_PRECONDITION', code: 'IDENTITY_PROFILE_INCOMPLETE' });
    // Message neutre : la même exigence garde la demande, le renouvellement et la recommande.
    expect((error as AppError).message).toBe('Complétez votre profil avant de continuer.');
    expect(calls).toEqual([]);
  });

  it('profil complet exigé et complet : transmise', async () => {
    const { useCase, calls } = setup(false);
    await useCase.execute({ operationId: 'cleaningSubmitRequest', requiresCompleteProfile: true }, call);
    expect(calls).toHaveLength(1);
  });
});
