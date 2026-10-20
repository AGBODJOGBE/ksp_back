import {
  type MfaChallenge,
  type OtpChallenge,
  type Profile,
  type SessionTokens,
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
    preferredLanguage: user.preferredLanguage,
    createdAt: user.createdAt,
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

export function presentProfile(profile: Profile) {
  return { user: presentUser(profile.user), profileIncomplete: profile.profileIncomplete };
}
