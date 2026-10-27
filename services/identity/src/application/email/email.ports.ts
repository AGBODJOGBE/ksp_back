import { type StoredOtpChallenge } from '../../domain/otp/otp-verification';
import { type EmailAddress } from '../../domain/user/email-address';
import { type Account } from '../session/session.ports';

/** Une demande de confirmation d'e-mail, enregistrée avant l'envoi du code. */
export interface NewEmailVerification {
  id: string;
  userId: string;
  email: EmailAddress;
  codeHash: string;
  expiresAt: Date;
  ip: string | null;
  createdAt: Date;
}

/** Demande enregistrée : mêmes règles de validité qu'un code par téléphone (`target` = adresse). */
export interface StoredEmailVerification extends StoredOtpChallenge {
  userId: string;
}

/** Événement identity.otp.requested d'un code envoyé par e-mail (jamais le code, ADR-014). */
export interface EmailCodeRequestedEvent {
  userId: string;
  purpose: 'email_verification';
  channel: 'email';
  targetMasked: string;
}

/** Écritures de la confirmation, faites en une seule transaction. */
export interface EmailConfirmation {
  verificationId: string;
  userId: string;
  email: string;
  now: Date;
}

/** La demande a déjà été utilisée entre-temps (deux confirmations simultanées). */
export class VerificationAlreadyConsumedError extends Error {
  override readonly name = 'VerificationAlreadyConsumedError';
}

/** Un autre compte a déjà confirmé cette adresse. */
export class EmailAlreadyUsedError extends Error {
  override readonly name = 'EmailAlreadyUsedError';
}

export interface EmailVerificationRepository {
  /** Dates des envois réussis vers cette adresse depuis `since`, tous comptes confondus. */
  sentAtForEmailSince(email: EmailAddress, since: Date): Promise<Date[]>;
  /** Dates des envois réussis demandés par ce compte depuis `since`, toutes adresses confondues. */
  sentAtForUserSince(userId: string, since: Date): Promise<Date[]>;
  create(verification: NewEmailVerification): Promise<void>;
  /** Envoi réussi, et événement dans la même transaction. */
  markSent(id: string, sentAt: Date, event: EmailCodeRequestedEvent): Promise<void>;
  /** Envoi impossible : la demande devient inutilisable et ne compte pas dans les limites. */
  markSendFailed(id: string, failedAt: Date): Promise<void>;
  /** Dernière demande du compte, envoyée ou non : seule celle-ci peut être confirmée. */
  findLatest(userId: string): Promise<StoredEmailVerification | null>;
  /** Compte un essai faux et renvoie le nombre d'essais, de façon atomique. */
  registerFailedAttempt(id: string): Promise<number>;
  /**
   * Consomme la demande, enregistre l'adresse comme e-mail vérifié du compte et écrit l'événement
   * identity.user.verified. Lève VerificationAlreadyConsumedError ou EmailAlreadyUsedError.
   */
  confirm(confirmation: EmailConfirmation): Promise<Account>;
}

/** Envoi du code par e-mail (appel gRPC direct à notification, comme les codes par téléphone, ADR-014). */
export interface EmailCodeSender {
  send(input: {
    verificationId: string;
    userId: string;
    email: EmailAddress;
    code: string;
    ttlSeconds: number;
  }): Promise<void>;
}
