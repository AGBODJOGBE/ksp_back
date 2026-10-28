import { identityV1 } from '@ksp/contracts';
import { type MembershipView } from '../../application/organization/organization.use-cases';
import { type OrganizationMemberView } from '../../application/organization/organization.ports';
import { type Account, type UserStatusName } from '../../application/session/session.ports';
import { type ActiveContext, type ContextType } from '../../domain/context/active-context';
import {
  type Organization,
  type OrganizationStatus,
  type OrgRole,
} from '../../domain/organization/organization';

export const USER_STATUS: Record<UserStatusName, identityV1.UserStatus> = {
  pending_verification: identityV1.UserStatus.USER_STATUS_PENDING_VERIFICATION,
  active: identityV1.UserStatus.USER_STATUS_ACTIVE,
  locked: identityV1.UserStatus.USER_STATUS_LOCKED,
  suspended: identityV1.UserStatus.USER_STATUS_SUSPENDED,
  deletion_pending: identityV1.UserStatus.USER_STATUS_DELETION_PENDING,
  deleted: identityV1.UserStatus.USER_STATUS_DELETED,
};

/** Compte → message User du contrat (chaîne vide pour une valeur absente, convention protobuf). */
export function toUserMessage(account: Account): identityV1.User {
  return {
    id: account.id,
    status: USER_STATUS[account.status],
    firstName: account.firstName ?? '',
    lastName: account.lastName ?? '',
    phoneE164: account.phoneE164 ?? '',
    email: account.email ?? '',
    preferredLanguage: account.preferredLanguage,
    createdAt: account.createdAt.toISOString(),
    emailVerified: account.email !== null && account.emailVerifiedAt !== null,
  };
}

const CONTEXT_TYPE: Record<ContextType, identityV1.ContextType> = {
  individual: identityV1.ContextType.CONTEXT_TYPE_INDIVIDUAL,
  business: identityV1.ContextType.CONTEXT_TYPE_BUSINESS,
};

/** Contexte actif → message ActiveContext (organisation vide pour un particulier). */
export function toActiveContextMessage(context: ActiveContext): identityV1.ActiveContext {
  return {
    type: CONTEXT_TYPE[context.type],
    organizationId: context.organizationId ?? '',
    organizationName: context.organizationName ?? '',
  };
}

export const ORGANIZATION_STATUS: Record<OrganizationStatus, identityV1.OrganizationStatus> = {
  pending_review: identityV1.OrganizationStatus.ORGANIZATION_STATUS_PENDING_REVIEW,
  active: identityV1.OrganizationStatus.ORGANIZATION_STATUS_ACTIVE,
  rejected: identityV1.OrganizationStatus.ORGANIZATION_STATUS_REJECTED,
  suspended: identityV1.OrganizationStatus.ORGANIZATION_STATUS_SUSPENDED,
};

const ORG_ROLE: Record<OrgRole, identityV1.OrgRole> = {
  org_admin: identityV1.OrgRole.ORG_ROLE_ADMIN,
  org_member: identityV1.OrgRole.ORG_ROLE_MEMBER,
  org_viewer: identityV1.OrgRole.ORG_ROLE_VIEWER,
};

const iso = (date: Date | null): string => (date ? date.toISOString() : '');

/** Organisation → message Organization (chaîne vide pour une valeur absente). */
export function toOrganizationMessage(organization: Organization): identityV1.Organization {
  return {
    id: organization.id,
    legalName: organization.legalName,
    address: organization.address,
    ifu: organization.ifu,
    rccm: organization.rccm ?? '',
    billingEmail: organization.billingEmail ?? '',
    status: ORGANIZATION_STATUS[organization.status],
    createdBy: organization.createdBy,
    createdAt: organization.createdAt.toISOString(),
    reviewedBy: organization.reviewedBy ?? '',
    reviewedAt: iso(organization.reviewedAt),
    rejectionReason: organization.rejectionReason ?? '',
    suspendedAt: iso(organization.suspendedAt),
    suspensionReason: organization.suspensionReason ?? '',
  };
}

/** Fiche lue par un autre service (GetOrganizationsByIds) : ni membres ni décisions du back-office. */
export function toOrganizationProfileMessage(organization: Organization): identityV1.OrganizationProfile {
  return {
    id: organization.id,
    legalName: organization.legalName,
    address: organization.address,
    ifu: organization.ifu,
    rccm: organization.rccm ?? '',
    billingEmail: organization.billingEmail ?? '',
    status: ORGANIZATION_STATUS[organization.status],
  };
}

export function toMembershipMessage(membership: MembershipView): identityV1.OrganizationMembership {
  return {
    organization: toOrganizationMessage(membership.organization),
    role: ORG_ROLE[membership.role],
    pendingBillingEmail: membership.pendingBillingEmail ?? '',
  };
}

export function toMemberMessage(member: OrganizationMemberView): identityV1.OrganizationMember {
  return {
    userId: member.userId,
    role: ORG_ROLE[member.role],
    firstName: member.firstName ?? '',
    lastName: member.lastName ?? '',
    phoneE164: member.phoneE164 ?? '',
    joinedAt: member.joinedAt.toISOString(),
  };
}
