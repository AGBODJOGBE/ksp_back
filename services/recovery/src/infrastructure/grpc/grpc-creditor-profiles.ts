import { type identityV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { type CreditorProfile, type CreditorProfiles } from '../../application/cases/ports';
import { type Holder } from '../../application/ports';
import { callDependency } from './dependency';

const fullName = (user: identityV1.User | undefined) =>
  [user?.firstName, user?.lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(' ');

/**
 * Identité du créancier imprimée sur le mandat (identity, jeton de service de recovery) : nom du
 * compte, ou raison sociale, adresse, IFU ou RCCM de l'organisation et nom du membre qui signe.
 * Téléphone et e-mail ne sont repris que si identity les transmet à recovery.
 */
export class GrpcCreditorProfiles implements CreditorProfiles {
  constructor(
    private readonly client: identityV1.IdentityServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  private async user(userId: string): Promise<identityV1.User | undefined> {
    const res = await callDependency<identityV1.GetUsersByIdsResponse>(
      'identity',
      this.caller,
      'getUsersByIds',
      (metadata) => this.client.getUsersByIds({ userIds: [userId] }, metadata),
      { idempotent: true },
    );
    return res.users.find((user) => user.id === userId);
  }

  async profile(creditor: { holder: Holder; userId: string }): Promise<CreditorProfile> {
    const user = await this.user(creditor.userId);
    if (creditor.holder.type === 'user') {
      return {
        name: fullName(user),
        kind: 'individual',
        identification: null,
        address: null,
        phone: user?.phoneE164 || null,
        email: user?.emailVerified ? user.email || null : null,
        representative: null,
      };
    }
    const res = await callDependency<identityV1.GetOrganizationsByIdsResponse>(
      'identity',
      this.caller,
      'getOrganizationsByIds',
      (metadata) => this.client.getOrganizationsByIds({ organizationIds: [creditor.holder.id] }, metadata),
      { idempotent: true },
    );
    const organization = res.organizations.find((candidate) => candidate.id === creditor.holder.id);
    return {
      name: organization?.legalName ?? '',
      kind: 'company',
      identification: organization?.ifu
        ? `IFU ${organization.ifu}`
        : organization?.rccm
          ? `RCCM ${organization.rccm}`
          : null,
      address: organization?.address || null,
      phone: null,
      email: organization?.billingEmail || null,
      representative: fullName(user) || null,
    };
  }
}
