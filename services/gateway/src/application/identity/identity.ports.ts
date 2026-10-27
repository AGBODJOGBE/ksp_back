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
  /** L'e-mail a été confirmé par un code : seule une adresse vérifiée reçoit des e-mails. */
  emailVerified: boolean;
  preferredLanguage: string;
  createdAt: string;
}

/**
 * Contexte actif de la session (claim ctx du jeton) : particulier (contexte personnel) ou
 * entreprise (organisation active). C'est lui qui décide, dans cleaning et billing, de la
 * facture mensuelle et de l'absence de choix du moyen de paiement.
 */
export type ContextType = 'individual' | 'business';

export interface ActiveContext {
  type: ContextType;
  /** Organisation active d'une entreprise ; null pour un particulier. */
  organizationId: string | null;
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
  activeContext: ActiveContext;
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

export interface TotpEnrollment {
  secret: string;
  otpauthUri: string;
  issuer: string;
  accountName: string;
  digits: number;
  periodSeconds: number;
}

/** Méthodes acceptées à la seconde étape d'un compte interne (jamais de SMS, ADR-023). */
export type SecondFactorMethod = 'totp' | 'recovery_code';

export interface Profile {
  user: UserProfile;
  profileIncomplete: boolean;
  /** Adresse en attente de confirmation par code ; null s'il n'y en a pas. */
  pendingEmail: string | null;
  activeContext: ActiveContext;
}

/** Code de confirmation envoyé à la nouvelle adresse e-mail. */
export interface EmailChange {
  pendingEmail: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
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
  enrollTotp(input: { mfaToken: string; clientKind: ClientKind }): Promise<TotpEnrollment>;
  confirmTotp(input: {
    mfaToken: string;
    code: string;
    clientKind: ClientKind;
  }): Promise<{ session: SessionTokens; recoveryCodes: string[] }>;
  verifyMfa(input: {
    mfaToken: string;
    method: SecondFactorMethod;
    code: string;
    clientKind: ClientKind;
  }): Promise<{ session: SessionTokens; recoveryCodesRemaining: number }>;
}

/** identity.AccountService : compte de l'utilisateur connecté. */
export interface IdentityAccount {
  getMe(): Promise<Profile>;
  updateMe(changes: ProfileChanges): Promise<Profile>;
  changeEmail(email: string): Promise<EmailChange>;
  confirmEmail(code: string): Promise<Profile>;
}
