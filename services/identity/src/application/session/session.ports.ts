import { type ClientKind } from '../../domain/session/session-policy';

export type UserStatusName =
  'pending_verification' | 'active' | 'locked' | 'suspended' | 'deletion_pending' | 'deleted';

/** Le compte tel que la connexion et les fronts en ont besoin. */
export interface Account {
  id: string;
  status: UserStatusName;
  firstName: string | null;
  lastName: string | null;
  phoneE164: string | null;
  /** Adresse e-mail, en minuscules ; null si aucune n'est enregistrée. */
  email: string | null;
  /** Confirmation de l'adresse par code ; seule une adresse vérifiée reçoit des e-mails. */
  emailVerifiedAt: Date | null;
  preferredLanguage: string;
  createdAt: Date;
}

/** Champs du profil modifiables par l'utilisateur ; un champ absent n'est pas modifié. */
export interface ProfileChanges {
  firstName?: string;
  lastName?: string;
  preferredLanguage?: string;
}

export interface AccountRepository {
  findByPhone(phoneE164: string): Promise<Account | null>;
  findById(userId: string): Promise<Account | null>;
  /** Applique les changements et renvoie le compte à jour, ou null si le compte n'existe pas. */
  updateProfile(userId: string, changes: ProfileChanges): Promise<Account | null>;
}

/** Écritures d'une connexion par téléphone réussie, faites en une seule transaction. */
export interface PhoneLoginPlan {
  challengeId: string;
  phoneE164: string;
  /** Compte existant, ou null pour créer le compte (identity.user.registered). */
  existingUserId: string | null;
  newUserId: string;
  newPhoneId: string;
  session: {
    id: string;
    clientKind: ClientKind;
    deviceLabel: string | null;
    userAgent: string | null;
    ip: string | null;
    expiresAt: Date;
  };
  refreshToken: { id: string; hash: string };
  loginEventId: string;
  maxSessions: number;
  now: Date;
}

/** La demande a déjà été utilisée entre-temps (deux validations simultanées). */
export class ChallengeAlreadyConsumedError extends Error {
  override readonly name = 'ChallengeAlreadyConsumedError';
}

/** Un autre appel a créé le compte de ce numéro entre-temps. */
export class PhoneAlreadyRegisteredError extends Error {
  override readonly name = 'PhoneAlreadyRegisteredError';
}

/** Méthode d'une étape de connexion, dans l'historique (login_events.method). */
export type LoginMethod = 'phone_otp' | 'totp' | 'recovery_code';

export interface FailedLogin {
  id: string;
  userId: string | null;
  reason: string;
  ip: string | null;
  userAgent: string | null;
  /** Absent : code par téléphone. */
  method?: LoginMethod;
}

export interface LoginRepository {
  /**
   * Consomme la demande, crée le compte si besoin, révoque les sessions au-delà de la limite,
   * ouvre la session avec son jeton de renouvellement, enregistre la connexion et l'événement.
   */
  completePhoneLogin(plan: PhoneLoginPlan): Promise<{ account: Account; isNewUser: boolean }>;
  recordFailedLogin(event: FailedLogin): Promise<void>;
}

/** Jeton de renouvellement : valeur aléatoire donnée au client, empreinte conservée. */
export interface RefreshTokenGenerator {
  generate(): { token: string; hash: string };
}
