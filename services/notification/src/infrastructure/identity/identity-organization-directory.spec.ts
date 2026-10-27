import { identityV1 } from '@ksp/contracts';
import { GrpcCaller } from '@ksp/platform';
import { of } from 'rxjs';
import { IdentityOrganizationDirectory } from './identity-organization-directory';

const organization = (id: string, billingEmail: string): identityV1.OrganizationProfile => ({
  id,
  legalName: 'SARL Bénin Propre',
  address: 'Lot 12, Haie Vive, Cotonou',
  ifu: '3201912345678',
  rccm: '',
  billingEmail,
  status: identityV1.OrganizationStatus.ORGANIZATION_STATUS_ACTIVE,
});

function directory(billingEmail = 'compta@benin-propre.bj') {
  const requests: identityV1.GetOrganizationsByIdsRequest[] = [];
  const client = {
    getOrganizationsByIds: (request: identityV1.GetOrganizationsByIdsRequest) => {
      requests.push(request);
      return of({ organizations: request.organizationIds.map((id) => organization(id, billingEmail)) });
    },
  } as unknown as identityV1.IdentityServiceClient;
  return {
    requests,
    directory: new IdentityOrganizationDirectory(client, new GrpcCaller({ target: 'identity' })),
  };
}

describe('IdentityOrganizationDirectory', () => {
  it('lit l’e-mail de facturation par GetOrganizationsByIds ; une chaîne vide vaut une valeur absente', async () => {
    const { directory: organizations, requests } = directory();
    await expect(organizations.findBillingContacts(['o-1'])).resolves.toEqual([
      { organizationId: 'o-1', legalName: 'SARL Bénin Propre', billingEmail: 'compta@benin-propre.bj' },
    ]);
    expect(requests).toEqual([{ organizationIds: ['o-1'] }]);
    await expect(directory('').directory.findBillingContacts(['o-1'])).resolves.toEqual([
      { organizationId: 'o-1', legalName: 'SARL Bénin Propre', billingEmail: null },
    ]);
  });

  it('découpe les demandes par lots de 100 identifiants (limite du contrat)', async () => {
    const { directory: organizations, requests } = directory();
    const ids = Array.from({ length: 150 }, (_, index) => `o-${index}`);
    await expect(organizations.findBillingContacts(ids)).resolves.toHaveLength(150);
    expect(requests.map((request) => request.organizationIds.length)).toEqual([100, 50]);
  });
});
