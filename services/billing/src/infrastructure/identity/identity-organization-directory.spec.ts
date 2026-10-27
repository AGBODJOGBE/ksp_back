import { identityV1 } from '@ksp/contracts';
import { AppError, GrpcCaller } from '@ksp/platform';
import { of, throwError } from 'rxjs';
import { IdentityOrganizationDirectory } from './identity-organization-directory';

const profile = (id: string): identityV1.OrganizationProfile => ({
  id,
  legalName: 'SARL Bénin Propre',
  address: 'Lot 12, Haie Vive, Cotonou',
  ifu: '3201912345678',
  rccm: '',
  billingEmail: '',
  status: identityV1.OrganizationStatus.ORGANIZATION_STATUS_ACTIVE,
});

function directory(fail = false) {
  const requests: identityV1.GetOrganizationsByIdsRequest[] = [];
  const client = {
    getOrganizationsByIds: (request: identityV1.GetOrganizationsByIdsRequest) => {
      requests.push(request);
      if (fail) {
        return throwError(() => new AppError('UNAVAILABLE', 'GRPC_UNAVAILABLE', 'identity indisponible'));
      }
      return of({ organizations: request.organizationIds.map(profile) });
    },
  } as unknown as identityV1.IdentityServiceClient;
  return {
    requests,
    directory: new IdentityOrganizationDirectory(
      client,
      new GrpcCaller({ target: 'identity', retryBackoffMs: 1 }),
    ),
  };
}

describe('IdentityOrganizationDirectory', () => {
  it('lit les fiches par GetOrganizationsByIds ; un RCCM vide vaut une valeur absente', async () => {
    const { directory: organizations, requests } = directory();
    await expect(organizations.findByIds(['o-1'])).resolves.toEqual([
      {
        id: 'o-1',
        legalName: 'SARL Bénin Propre',
        address: 'Lot 12, Haie Vive, Cotonou',
        ifu: '3201912345678',
        rccm: null,
      },
    ]);
    expect(requests).toEqual([{ organizationIds: ['o-1'] }]);
  });

  it('découpe les demandes par lots de 100 identifiants (limite du contrat)', async () => {
    const { directory: organizations, requests } = directory();
    const ids = Array.from({ length: 150 }, (_, index) => `o-${index}`);
    await expect(organizations.findByIds(ids)).resolves.toHaveLength(150);
    expect(requests.map((request) => request.organizationIds.length)).toEqual([100, 50]);
  });

  it('identity indisponible : lecture rejouée une fois, puis erreur (émission reportée)', async () => {
    const { directory: organizations, requests } = directory(true);
    await expect(organizations.findByIds(['o-1'])).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
    expect(requests).toHaveLength(2);
  });
});
