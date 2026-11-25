import { type identityV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { firstValueFrom, isObservable, of } from 'rxjs';
import { GrpcCreditorProfiles } from './grpc-creditor-profiles';

const caller = {
  call: async (_name: string, invoke: (metadata: never) => unknown) => {
    const result = invoke({} as never);
    return isObservable(result) ? firstValueFrom(result) : result;
  },
} as unknown as GrpcCaller;

const client = {
  getUsersByIds: () =>
    of({
      users: [
        {
          id: 'u-1',
          firstName: 'Awa',
          lastName: 'Houngbo',
          phoneE164: '+2290197000001',
          email: 'awa@example.com',
          emailVerified: false,
        },
      ],
    }),
  getOrganizationsByIds: () =>
    of({
      organizations: [
        {
          id: 'o-1',
          legalName: 'SARL Atlantique',
          address: 'Ganhi, Cotonou',
          ifu: '3201900000002',
          rccm: '',
          billingEmail: '',
        },
      ],
    }),
} as unknown as identityV1.IdentityServiceClient;

describe('identité du créancier pour le mandat (identity)', () => {
  const profiles = new GrpcCreditorProfiles(client, caller);

  it('compte personnel : nom et téléphone, e-mail seulement vérifié', async () => {
    expect(await profiles.profile({ holder: { type: 'user', id: 'u-1' }, userId: 'u-1' })).toEqual({
      name: 'Awa Houngbo',
      kind: 'individual',
      identification: null,
      address: null,
      phone: '+2290197000001',
      email: null,
      representative: null,
    });
  });

  it('organisation : raison sociale, adresse, IFU et membre qui signe', async () => {
    expect(await profiles.profile({ holder: { type: 'organization', id: 'o-1' }, userId: 'u-1' })).toEqual({
      name: 'SARL Atlantique',
      kind: 'company',
      identification: 'IFU 3201900000002',
      address: 'Ganhi, Cotonou',
      phone: null,
      email: null,
      representative: 'Awa Houngbo',
    });
  });
});
