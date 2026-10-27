import { type identityV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import {
  type OrganizationBillingContact,
  type OrganizationDirectory,
} from '../../application/events/event-notification.ports';

/** Limite de GetOrganizationsByIds (contrat identity.proto). */
const BATCH = 100;

/**
 * Raison sociale et e-mail de facturation des organisations lus dans identity par gRPC (GetOrganizationsByIds), avec
 * le jeton de service de notification (ADR-022). identity ne transmet qu'une adresse vérifiée par
 * code. Lecture sans effet : l'appel peut être rejoué par l'appelant.
 */
export class IdentityOrganizationDirectory implements OrganizationDirectory {
  constructor(
    private readonly client: identityV1.IdentityServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async findBillingContacts(organizationIds: readonly string[]): Promise<OrganizationBillingContact[]> {
    const contacts: OrganizationBillingContact[] = [];
    for (let start = 0; start < organizationIds.length; start += BATCH) {
      const request: identityV1.GetOrganizationsByIdsRequest = {
        organizationIds: organizationIds.slice(start, start + BATCH),
      };
      const response = await this.caller.call(
        'getOrganizationsByIds',
        (metadata) => this.client.getOrganizationsByIds(request, metadata),
        { idempotent: true },
      );
      contacts.push(
        ...response.organizations.map((organization) => ({
          organizationId: organization.id,
          legalName: organization.legalName,
          // Convention protobuf : une chaîne vide vaut une valeur absente.
          billingEmail: organization.billingEmail || null,
        })),
      );
    }
    return contacts;
  }
}
