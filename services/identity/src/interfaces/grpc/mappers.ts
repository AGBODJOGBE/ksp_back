import { identityV1 } from '@ksp/contracts';
import { type Account, type UserStatusName } from '../../application/session/session.ports';
import { type ActiveContext, type ContextType } from '../../domain/context/active-context';

const STATUS: Record<UserStatusName, identityV1.UserStatus> = {
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
    status: STATUS[account.status],
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
  return { type: CONTEXT_TYPE[context.type], organizationId: context.organizationId ?? '' };
}
