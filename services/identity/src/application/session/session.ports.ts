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
  email: string | null;
  preferredLanguage: string;
  createdAt: Date;
}

export interface AccountRepository {
  findByPhone(phoneE164: string): Promise<Account | null>;
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

export interface LoginRepository {
  /**
   * Consomme la demande, crée le compte si besoin, révoque les sessions au-delà de la limite,
   * ouvre la session avec son jeton de renouvellement, enregistre la connexion et l'événement.
   */
  completePhoneLogin(plan: PhoneLoginPlan): Promise<{ account: Account; isNewUser: boolean }>;
  recordFailedLogin(event: {
    id: string;
    userId: string | null;
    reason: string;
    ip: string | null;
    userAgent: string | null;
  }): Promise<void>;
}

/** Jeton de renouvellement : valeur aléatoire donnée au client, empreinte conservée. */
export interface RefreshTokenGenerator {
  generate(): { token: string; hash: string };
}
