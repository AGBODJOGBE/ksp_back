import { type ClientKind } from '../../domain/client/client-kind';

/**
 * Vue de la gateway sur le service identity, indépendante de gRPC : l'adaptateur traduit
 * ces types depuis et vers les messages protobuf (énumérations, chaînes vides ↔ null).
 * L'utilisateur connecté n'apparaît jamais dans les paramètres : il voyage dans le contexte de la requête.
 */
export type OtpChannel = 'sms' | 'whatsapp';
export type UserStatus =
  'pending_verification' | 'active' | 'locked' | 'suspended' | 'deletion_pending' | 'deleted';
export type MfaMethod = 'totp' | 'recovery_code' | 'sms';
export type LogoutScope = 'this_device' | 'all_devices';

export interface UserProfile {
  id: string;
  status: UserStatus;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  preferredLanguage: string;
  createdAt: string;
}

export interface OtpChallenge {
  challengeId: string;
  maskedTarget: string;
  channel: OtpChannel;
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

export interface SessionTokens {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  sessionId: string;
  user: UserProfile;
  profileIncomplete: boolean;
}

export interface MfaChallenge {
  mfaToken: string;
  expiresAt: string;
  methods: MfaMethod[];
  enrollmentRequired: boolean;
}

export type LoginOutcome =
  | { status: 'authenticated'; session: SessionTokens; isNewUser: boolean }
  | { status: 'mfa_required'; challenge: MfaChallenge };

export interface Profile {
  user: UserProfile;
  profileIncomplete: boolean;
}

export interface ProfileChanges {
  firstName?: string;
  lastName?: string;
  preferredLanguage?: string;
}

/** identity.AuthService : connexion et sessions. */
export interface IdentityAuth {
  /** Canal absent : identity choisit (WhatsApp au lancement, ADR-021). */
  requestOtp(input: { phone: string; channel: OtpChannel | null }): Promise<OtpChallenge>;
  verifyOtp(input: {
    challengeId: string;
    code: string;
    clientKind: ClientKind;
    deviceLabel: string | null;
  }): Promise<LoginOutcome>;
  refreshSession(refreshToken: string): Promise<SessionTokens>;
  /** Renvoie le nombre de sessions révoquées. */
  logout(scope: LogoutScope): Promise<number>;
}

/** identity.AccountService : compte de l'utilisateur connecté. */
export interface IdentityAccount {
  getMe(): Promise<Profile>;
  updateMe(changes: ProfileChanges): Promise<Profile>;
}
