import { identityV1 } from '@ksp/contracts';
import { AppError, GrpcCaller } from '@ksp/platform';
import { of, throwError } from 'rxjs';
import { IdentityAgentAccounts } from './identity-agent-accounts';

const USER = '0192f1c4-0000-7000-8000-00000000a002';
const INPUT = { phone: '+2290197000045', firstName: 'Awa', lastName: 'Dossou' };

function adapter(answer: () => unknown) {
  const requests: identityV1.EnsureUserByPhoneRequest[] = [];
  const client = {
    ensureUserByPhone: (request: identityV1.EnsureUserByPhoneRequest) => {
      requests.push(request);
      return answer();
    },
  } as unknown as identityV1.IdentityServiceClient;
  return {
    requests,
    accounts: new IdentityAgentAccounts(client, new GrpcCaller({ target: 'identity', retryBackoffMs: 1 })),
  };
}

describe('IdentityAgentAccounts (identity.EnsureUserByPhone, R-AG-02)', () => {
  it('rend le compte du numéro, créé en attente de vérification s’il manquait', async () => {
    const { accounts, requests } = adapter(() =>
      of({
        userId: USER,
        status: identityV1.UserStatus.USER_STATUS_PENDING_VERIFICATION,
        created: true,
      }),
    );
    await expect(accounts.ensureByPhone(INPUT)).resolves.toEqual({
      userId: USER,
      status: 'pending_verification',
      created: true,
    });
    expect(requests).toEqual([{ phoneE164: '+2290197000045', firstName: 'Awa', lastName: 'Dossou' }]);
    const existing = adapter(() =>
      of({ userId: USER, status: identityV1.UserStatus.USER_STATUS_ACTIVE, created: false }),
    );
    await expect(existing.accounts.ensureByPhone(INPUT)).resolves.toEqual({
      userId: USER,
      status: 'active',
      created: false,
    });
  });

  it('identity injoignable : une nouvelle tentative (appel idempotent), puis IDENTITY_UNAVAILABLE', async () => {
    const { accounts, requests } = adapter(() =>
      throwError(() => new AppError('UNAVAILABLE', 'GRPC_UNAVAILABLE', 'identity injoignable')),
    );
    await expect(accounts.ensureByPhone(INPUT)).rejects.toMatchObject({
      kind: 'UNAVAILABLE',
      code: 'IDENTITY_UNAVAILABLE',
    });
    expect(requests).toHaveLength(2);
  });

  it('refus d’identity transmis tel quel ; réponse sans compte : erreur', async () => {
    const refused = adapter(() =>
      throwError(() =>
        AppError.precondition('IDENTITY_ACCOUNT_NOT_USABLE', 'Compte inutilisable.', { status: 'suspended' }),
      ),
    );
    await expect(refused.accounts.ensureByPhone(INPUT)).rejects.toMatchObject({
      code: 'IDENTITY_ACCOUNT_NOT_USABLE',
      details: { status: 'suspended' },
    });
    expect(refused.requests).toHaveLength(1);
    await expect(adapter(() => of({ userId: '' })).accounts.ensureByPhone(INPUT)).rejects.toThrow(
      'Réponse d’identity sans compte.',
    );
  });
});
