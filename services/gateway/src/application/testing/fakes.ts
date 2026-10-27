/** Doublures des ports de l'application, pour les tests des cas d'usage. */
import { AppError, type VerifiedAccessToken } from '@ksp/platform';
import { type AccessTokenVerifierPort, type RateLimiter, type RateLimitResult } from '../access/access.ports';
import {
  type ActiveContext,
  type EmailChange,
  type IdentityAccount,
  type IdentityAuth,
  type LoginOutcome,
  type LogoutScope,
  type OtpChallenge,
  type Profile,
  type ProfileChanges,
  type SessionTokens,
  type UserProfile,
} from '../identity/identity.ports';

export function verifiedToken(overrides: Partial<VerifiedAccessToken['user']> = {}): VerifiedAccessToken {
  return {
    user: {
      userId: 'u-1',
      sessionId: 's-1',
      activeContext: 'personal',
      roles: [{ role: 'customer', scopeType: 'personal', scopeId: null }],
      mfa: false,
      authTime: 1_792_400_000,
      ...overrides,
    },
    clientId: 'web',
    tokenId: 'j-1',
    expiresAt: 1_792_400_900,
  };
}

/** Jetons connus par leur texte ; tout autre jeton est invalide. */
export class FakeTokenVerifier implements AccessTokenVerifierPort {
  readonly tokens = new Map<string, VerifiedAccessToken>();

  async verify(token: string): Promise<VerifiedAccessToken> {
    const found = this.tokens.get(token);
    if (!found) throw AppError.unauthenticated('GATEWAY_TOKEN_INVALID', 'Jeton invalide.');
    return found;
  }
}

/** Compteurs sans fenêtre de temps : la limite est atteinte après `limit` appels. */
export class CountingRateLimiter implements RateLimiter {
  readonly counts = new Map<string, number>();

  async consume(key: string, rule: { limit: number; windowSeconds: number }): Promise<RateLimitResult> {
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return count <= rule.limit
      ? { allowed: true, retryAfterSeconds: 0 }
      : { allowed: false, retryAfterSeconds: rule.windowSeconds };
  }
}

export const user: UserProfile = {
  id: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e11',
  status: 'active',
  firstName: null,
  lastName: null,
  phone: '+2290197000045',
  email: null,
  emailVerified: false,
  preferredLanguage: 'fr',
  createdAt: '2026-10-17T10:00:00.000Z',
};

/** Contexte personnel : celui de toute session à son ouverture. */
export const individual: ActiveContext = { type: 'individual', organizationId: null, organizationName: null };

export const session: SessionTokens = {
  accessToken: 'jwt',
  accessTokenExpiresAt: '2026-10-17T10:15:00.000Z',
  refreshToken: 'rt-2',
  refreshTokenExpiresAt: '2026-11-16T10:00:00.000Z',
  sessionId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e10',
  user,
  profileIncomplete: true,
  activeContext: individual,
};

/** identity simulé : enregistre chaque appel et renvoie une réponse type. */
export class FakeIdentity implements IdentityAuth, IdentityAccount {
  readonly calls: { method: string; input: unknown }[] = [];

  async requestOtp(input: { phone: string; channel: 'sms' | 'whatsapp' | null }): Promise<OtpChallenge> {
    this.calls.push({ method: 'requestOtp', input });
    return {
      challengeId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e0f',
      maskedTarget: '+229********45',
      channel: input.channel ?? 'whatsapp',
      expiresInSeconds: 300,
      resendAfterSeconds: 60,
    };
  }

  async verifyOtp(input: Parameters<IdentityAuth['verifyOtp']>[0]): Promise<LoginOutcome> {
    this.calls.push({ method: 'verifyOtp', input });
    return { status: 'authenticated', session, isNewUser: true };
  }

  async refreshSession(refreshToken: string): Promise<SessionTokens> {
    this.calls.push({ method: 'refreshSession', input: refreshToken });
    return session;
  }

  async logout(scope: LogoutScope): Promise<number> {
    this.calls.push({ method: 'logout', input: scope });
    return scope === 'all_devices' ? 3 : 1;
  }

  async enrollTotp(input: Parameters<IdentityAuth['enrollTotp']>[0]) {
    this.calls.push({ method: 'enrollTotp', input });
    return {
      secret: 'JBSWY3DPEHPK3PXP',
      otpauthUri: 'otpauth://totp/KSP:%2B2290197000045?secret=JBSWY3DPEHPK3PXP&issuer=KSP',
      issuer: 'KSP',
      accountName: '+2290197000045',
      digits: 6,
      periodSeconds: 30,
    };
  }

  async confirmTotp(input: Parameters<IdentityAuth['confirmTotp']>[0]) {
    this.calls.push({ method: 'confirmTotp', input });
    return { session, recoveryCodes: ['7KQ2M-X9PDA'] };
  }

  async verifyMfa(input: Parameters<IdentityAuth['verifyMfa']>[0]) {
    this.calls.push({ method: 'verifyMfa', input });
    return { session, recoveryCodesRemaining: 10 };
  }

  async getMe(): Promise<Profile> {
    this.calls.push({ method: 'getMe', input: undefined });
    return { user, profileIncomplete: true, pendingEmail: null, activeContext: individual };
  }

  async updateMe(changes: ProfileChanges): Promise<Profile> {
    this.calls.push({ method: 'updateMe', input: changes });
    return {
      user: { ...user, ...changes },
      profileIncomplete: false,
      pendingEmail: null,
      activeContext: individual,
    };
  }

  async changeEmail(email: string): Promise<EmailChange> {
    this.calls.push({ method: 'changeEmail', input: email });
    return { pendingEmail: email.trim().toLowerCase(), expiresInSeconds: 900, resendAfterSeconds: 60 };
  }

  async confirmEmail(code: string): Promise<Profile> {
    this.calls.push({ method: 'confirmEmail', input: code });
    return {
      user: { ...user, email: 'koffi@exemple.com', emailVerified: true },
      profileIncomplete: true,
      pendingEmail: null,
      activeContext: individual,
    };
  }
}
