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

const ORG = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0a01';

function setup(
  profileIncomplete: boolean,
  context: { organizationId: string | null; ifu?: string } = { organizationId: null },
) {
  const calls: { operationId: string; call: CleaningCall }[] = [];
  const cleaning: CleaningApi = {
    call: async (operationId, input) => {
      calls.push({ operationId, call: input });
      return { ok: true };
    },
  };
  const activeContext = context.organizationId
    ? { type: 'business', organizationId: context.organizationId, organizationName: 'Hôtel du Lac' }
    : { type: 'individual', organizationId: null, organizationName: null };
  const identity = { getMe: jest.fn(async () => ({ profileIncomplete, activeContext }) as never) };
  const organizations = {
    getMine: jest.fn(async () => ({ organization: { id: ORG, ifu: context.ifu ?? '' } }) as never),
  };
  return {
    useCase: new CallCleaningUseCase(identity, organizations, cleaning),
    calls,
    identity,
    organizations,
  };
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

  it('contexte personnel complet : l’organisation n’est jamais lue', async () => {
    const { useCase, organizations } = setup(false);
    await useCase.execute({ operationId: 'cleaningSubmitRequest', requiresCompleteProfile: true }, call);
    expect(organizations.getMine).not.toHaveBeenCalled();
  });

  it('organisation active avec son IFU : transmise (R-CP-02)', async () => {
    const { useCase, calls, organizations } = setup(false, { organizationId: ORG, ifu: '3201234567890' });
    await useCase.execute({ operationId: 'cleaningSubmitRequest', requiresCompleteProfile: true }, call);
    expect(organizations.getMine).toHaveBeenCalledWith(ORG);
    expect(calls).toHaveLength(1);
  });

  it('organisation active sans IFU : 422 IDENTITY_PROFILE_INCOMPLETE (R-CP-02)', async () => {
    const { useCase, calls } = setup(false, { organizationId: ORG });
    const error = await useCase
      .execute({ operationId: 'cleaningSubmitRequest', requiresCompleteProfile: true }, call)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'FAILED_PRECONDITION', code: 'IDENTITY_PROFILE_INCOMPLETE' });
    expect(calls).toEqual([]);
  });
});
