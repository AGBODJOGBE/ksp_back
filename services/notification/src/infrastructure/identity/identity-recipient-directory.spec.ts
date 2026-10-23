import { identityV1 } from '@ksp/contracts';
import { GrpcCaller } from '@ksp/platform';
import { of } from 'rxjs';
import { IdentityRecipientDirectory } from './identity-recipient-directory';

const user = (id: string, overrides: Partial<identityV1.User> = {}): identityV1.User => ({
  id,
  status: identityV1.UserStatus.USER_STATUS_ACTIVE,
  firstName: 'Koffi',
  lastName: 'Adjovi',
  phoneE164: '+2290197000045',
  email: '',
  preferredLanguage: '',
  createdAt: '2026-10-19T12:00:00.000Z',
  ...overrides,
});

function directory() {
  const requests: identityV1.GetUsersByIdsRequest[] = [];
  const client = {
    getUsersByIds: (request: identityV1.GetUsersByIdsRequest) => {
      requests.push(request);
      return of({ users: request.userIds.map((id) => user(id)) });
    },
  } as unknown as identityV1.IdentityServiceClient;
  return {
    requests,
    directory: new IdentityRecipientDirectory(client, new GrpcCaller({ target: 'identity' })),
  };
}

describe('IdentityRecipientDirectory', () => {
  it('lit les coordonnées par GetUsersByIds ; une chaîne vide vaut une valeur absente', async () => {
    const { directory: contacts, requests } = directory();
    await expect(contacts.findContacts(['u-1'])).resolves.toEqual([
      { userId: 'u-1', firstName: 'Koffi', phoneE164: '+2290197000045', email: null, language: 'fr' },
    ]);
    expect(requests).toEqual([{ userIds: ['u-1'] }]);
  });

  it('découpe les demandes par lots de 100 identifiants (limite du contrat)', async () => {
    const { directory: contacts, requests } = directory();
    const ids = Array.from({ length: 150 }, (_, index) => `u-${index}`);
    await expect(contacts.findContacts(ids)).resolves.toHaveLength(150);
    expect(requests.map((request) => request.userIds.length)).toEqual([100, 50]);
  });
});
