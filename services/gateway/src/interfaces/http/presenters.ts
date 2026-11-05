import {
  type AccountDeletion,
  type ActiveContext,
  type CancelledDeletion,
  type EmailChange,
  type MfaChallenge,
  type OtpChallenge,
  type Profile,
  type SessionTokens,
  type TotpEnrollment,
  type UserProfile,
} from '../../application/identity/identity.ports';

/** Réponses REST du contrat OpenAPI (components/schemas), en camelCase. */

export function presentUser(user: UserProfile) {
  return {
    id: user.id,
    status: user.status,
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone,
    email: user.email,
    emailVerified: user.emailVerified,
    preferredLanguage: user.preferredLanguage,
    createdAt: user.createdAt,
  };
}

/** Particulier ou entreprise : le type de compte réel, celui que lisent cleaning et billing. */
export function presentActiveContext(context: ActiveContext) {
  return {
    type: context.type,
    organizationId: context.organizationId,
    organizationName: context.organizationName,
  };
}

export function presentOtpChallenge(challenge: OtpChallenge) {
  return {
    challengeId: challenge.challengeId,
    maskedTarget: challenge.maskedTarget,
    channel: challenge.channel,
    expiresInSeconds: challenge.expiresInSeconds,
    resendAfterSeconds: challenge.resendAfterSeconds,
  };
}

/**
 * Session ouverte ou renouvelée (SessionResponse). Le jeton de renouvellement n'apparaît dans le
 * corps que pour le mobile ; un navigateur le reçoit dans le cookie.
 */
export function presentSession(session: SessionTokens, refreshTokenInBody: boolean) {
  return {
    status: 'authenticated' as const,
    accessToken: session.accessToken,
    accessTokenExpiresAt: session.accessTokenExpiresAt,
    ...(refreshTokenInBody ? { refreshToken: session.refreshToken } : {}),
    refreshTokenExpiresAt: session.refreshTokenExpiresAt,
    sessionId: session.sessionId,
    user: presentUser(session.user),
    profileIncomplete: session.profileIncomplete,
    activeContext: presentActiveContext(session.activeContext),
  };
}

export function presentMfaRequired(challenge: MfaChallenge) {
  return {
    status: 'mfa_required' as const,
    mfaToken: challenge.mfaToken,
    expiresAt: challenge.expiresAt,
    methods: challenge.methods,
    enrollmentRequired: challenge.enrollmentRequired,
  };
}

export function presentTotpEnrollment(enrollment: TotpEnrollment) {
  return {
    secret: enrollment.secret,
    otpauthUri: enrollment.otpauthUri,
    issuer: enrollment.issuer,
    accountName: enrollment.accountName,
    digits: enrollment.digits,
    periodSeconds: enrollment.periodSeconds,
  };
}

export function presentDeletion(deletion: AccountDeletion) {
  return {
    requestedAt: deletion.requestedAt,
    scheduledFor: deletion.scheduledFor,
    postponedBy: deletion.postponedBy.map((obstacle) => ({
      service: obstacle.service,
      kind: obstacle.kind,
      reference: obstacle.reference,
      description: obstacle.description,
    })),
  };
}

export function presentProfile(profile: Profile) {
  return {
    user: presentUser(profile.user),
    profileIncomplete: profile.profileIncomplete,
    pendingEmail: profile.pendingEmail,
    activeContext: presentActiveContext(profile.activeContext),
    deletion: profile.deletion ? presentDeletion(profile.deletion) : null,
  };
}

export function presentCancelledDeletion(result: CancelledDeletion) {
  return {
    user: presentUser(result.user),
    profileIncomplete: result.profileIncomplete,
    activeContext: presentActiveContext(result.activeContext),
    accessToken: result.accessToken,
    accessTokenExpiresAt: result.accessTokenExpiresAt,
  };
}

export function presentEmailChange(change: EmailChange) {
  return {
    pendingEmail: change.pendingEmail,
    expiresInSeconds: change.expiresInSeconds,
    resendAfterSeconds: change.resendAfterSeconds,
  };
}
