import { identityV1 } from '@ksp/contracts';
import { AppError, GrpcCaller } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { displayName, IdentityPeopleDirectory } from './identity-people-directory';

const user = (id: string, firstName = 'Koffi', lastName = 'Adjovi'): identityV1.User => ({
  id,
  status: identityV1.UserStatus.USER_STATUS_ACTIVE,
  firstName,
  lastName,
  phoneE164: '',
  email: '',
  preferredLanguage: 'fr',
  createdAt: '2026-10-19T12:00:00.000Z',
  emailVerified: false,
});

function directory(fail = false) {
  const userCalls: string[][] = [];
  const organizationCalls: string[][] = [];
  const unavailable = () =>
    throwError(() => new AppError('UNAVAILABLE', 'IDENTITY_UNAVAILABLE', 'identity indisponible'));
  const client = {
    getUsersByIds: (request: identityV1.GetUsersByIdsRequest) => {
      userCalls.push(request.userIds);
      if (fail) return unavailable();
      return of({ users: request.userIds.filter((id) => id !== 'sans-nom').map((id) => user(id)) });
    },
    getOrganizationsByIds: (request: identityV1.GetOrganizationsByIdsRequest) => {
      organizationCalls.push(request.organizationIds);
      if (fail) return unavailable();
      return of({
        organizations: request.organizationIds.map((id) => ({
          id,
          legalName: 'SARL Bénin Propre',
          address: '',
          ifu: '',
          rccm: '',
          billingEmail: '',
          status: identityV1.OrganizationStatus.ORGANIZATION_STATUS_ACTIVE,
        })),
      });
    },
  } as unknown as identityV1.IdentityServiceClient;
  return {
    userCalls,
    organizationCalls,
    people: new IdentityPeopleDirectory(client, new GrpcCaller({ target: 'identity', retryBackoffMs: 1 })),
  };
}

describe('IdentityPeopleDirectory', () => {
  beforeAll(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterAll(() => jest.restoreAllMocks());

  it('nom affiché : prénom et nom, sans espace en trop ; vide sans profil', () => {
    expect(displayName({ firstName: ' Koffi ', lastName: 'Adjovi' })).toBe('Koffi Adjovi');
    expect(displayName({ firstName: '', lastName: 'Adjovi' })).toBe('Adjovi');
    expect(displayName({ firstName: '', lastName: '' })).toBe('');
  });

  it('lit les comptes par lots de 100 et les organisations par GetOrganizationsByIds', async () => {
    const { people, userCalls, organizationCalls } = directory();
    const ids = Array.from({ length: 150 }, (_, index) => `u-${index}`);
    const names = await people.userNames(ids);
    expect(userCalls.map((batch) => batch.length)).toEqual([100, 50]);
    expect(names.get('u-149')).toBe('Koffi Adjovi');
    expect((await people.organizationNames(['o-1'])).get('o-1')).toBe('SARL Bénin Propre');
    expect(organizationCalls).toEqual([['o-1']]);
  });

  it('identity indisponible : noms absents, sans erreur', async () => {
    const { people } = directory(true);
    await expect(people.userNames(['u-1'])).resolves.toEqual(new Map());
    await expect(people.organizationNames(['o-1'])).resolves.toEqual(new Map());
  });
});
