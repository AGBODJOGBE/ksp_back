import { type identityV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { type OrganizationDirectory, type OrganizationProfile } from '../../application/ports';

/** Limite de GetOrganizationsByIds (contrat identity.proto). */
const BATCH = 100;

/**
 * Fiches des organisations facturées, lues dans identity par gRPC (GetOrganizationsByIds), avec le
 * jeton de service de billing (ADR-022) : délai, nouvelle tentative et coupe-circuit du GrpcCaller.
 * Lecture sans effet : l'appel peut être rejoué.
 */
export class IdentityOrganizationDirectory implements OrganizationDirectory {
  constructor(
    private readonly client: identityV1.IdentityServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async findByIds(organizationIds: readonly string[]): Promise<OrganizationProfile[]> {
    const profiles: OrganizationProfile[] = [];
    for (let start = 0; start < organizationIds.length; start += BATCH) {
      const request: identityV1.GetOrganizationsByIdsRequest = {
        organizationIds: organizationIds.slice(start, start + BATCH),
      };
      const response = await this.caller.call(
        'getOrganizationsByIds',
        (metadata) => this.client.getOrganizationsByIds(request, metadata),
        { idempotent: true },
      );
      profiles.push(...response.organizations.map(toProfile));
    }
    return profiles;
  }
}

/** Convention protobuf : une chaîne vide vaut une valeur absente (RCCM facultatif). */
function toProfile(organization: identityV1.OrganizationProfile): OrganizationProfile {
  return {
    id: organization.id,
    legalName: organization.legalName,
    address: organization.address,
    ifu: organization.ifu,
    rccm: organization.rccm || null,
  };
}
