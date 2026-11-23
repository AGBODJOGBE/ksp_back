import { type identityV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { type Directory, type PersonSummary } from '../../application/ports';
import { callDependency } from './dependency';

/** Limite de GetUsersByIds et GetOrganizationsByIds (contrat identity.proto). */
const BATCH = 100;

function chunks<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += BATCH) result.push(values.slice(start, start + BATCH));
  return result;
}

/**
 * Comptes et organisations chez identity (IdentityService), avec le jeton de service de recovery :
 * noms affichés seulement (le créancier, le chargé, le partenaire), jamais de coordonnées.
 */
export class GrpcDirectory implements Directory {
  constructor(
    private readonly client: identityV1.IdentityServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async usersByIds(ids: readonly string[]): Promise<PersonSummary[]> {
    const people: PersonSummary[] = [];
    for (const batch of chunks([...new Set(ids)])) {
      const res = await callDependency<identityV1.GetUsersByIdsResponse>(
        'identity',
        this.caller,
        'getUsersByIds',
        (metadata) => this.client.getUsersByIds({ userIds: batch }, metadata),
        { idempotent: true },
      );
      for (const user of res.users) {
        const displayName = [user.firstName, user.lastName]
          .map((part) => part.trim())
          .filter(Boolean)
          .join(' ');
        people.push({ userId: user.id, displayName });
      }
    }
    return people;
  }

  async organizationsByIds(
    ids: readonly string[],
  ): Promise<{ organizationId: string; displayName: string }[]> {
    const organizations: { organizationId: string; displayName: string }[] = [];
    for (const batch of chunks([...new Set(ids)])) {
      const res = await callDependency<identityV1.GetOrganizationsByIdsResponse>(
        'identity',
        this.caller,
        'getOrganizationsByIds',
        (metadata) => this.client.getOrganizationsByIds({ organizationIds: batch }, metadata),
        { idempotent: true },
      );
      for (const organization of res.organizations) {
        organizations.push({ organizationId: organization.id, displayName: organization.legalName });
      }
    }
    return organizations;
  }
}
