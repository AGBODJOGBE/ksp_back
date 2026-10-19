import { type OtpChallenge, type OtpChannel } from '../../domain/otp/otp-challenge';
import { type StoredOtpChallenge } from '../../domain/otp/otp-verification';
import { type PhoneNumber } from '../../domain/user/phone-number';

/** Événement identity.otp.requested, écrit dans l'outbox avec la mise à jour de la demande. */
export interface OtpRequestedEvent {
  userId: string | null;
  purpose: 'login';
  channel: OtpChannel;
  targetMasked: string;
}

export interface OtpChallengeRepository {
  /** Dates des envois réussis vers ce numéro depuis `since`. */
  sentAtSince(target: PhoneNumber, since: Date): Promise<Date[]>;
  /** Enregistre une nouvelle demande, avant l'envoi. */
  create(challenge: OtpChallenge): Promise<void>;
  /** Envoi réussi : canal réellement utilisé, et événement dans la même transaction. */
  markSent(id: string, channelUsed: OtpChannel, sentAt: Date, event: OtpRequestedEvent): Promise<void>;
  /** Envoi impossible : la demande devient inutilisable et ne compte pas dans les limites. */
  markSendFailed(id: string, failedAt: Date): Promise<void>;
  findById(id: string): Promise<StoredOtpChallenge | null>;
  /** Compte un essai faux et renvoie le nombre d'essais, de façon atomique. */
  registerFailedAttempt(id: string): Promise<number>;
}

/** Envoi du code au destinataire (appel gRPC direct à notification, ADR-014). */
export interface OtpSender {
  send(input: {
    challengeId: string;
    target: PhoneNumber;
    channel: OtpChannel;
    code: string;
    ttlSeconds: number;
  }): Promise<{ channelUsed: OtpChannel }>;
}

/** Empreinte du code : la base ne contient jamais le code en clair. */
export interface OtpHasher {
  hash(challengeId: string, code: string): string;
  /** Comparaison en temps constant avec l'empreinte enregistrée. */
  matches(challengeId: string, code: string, codeHash: string): boolean;
}

export interface OtpCodeGenerator {
  generate(length: number): string;
}
