import { type OtpChallenge, type OtpChannel } from '../../domain/otp/otp-challenge';
import { type SendDecision } from '../../domain/otp/otp-policy';
import { type StoredOtpChallenge } from '../../domain/otp/otp-verification';
import { type PhoneNumber } from '../../domain/user/phone-number';

/** Événement identity.otp.requested, écrit dans l'outbox avec la mise à jour de la demande. */
export interface OtpRequestedEvent {
  userId: string | null;
  purpose: 'login';
  channel: OtpChannel;
  targetMasked: string;
}

/** Résultat d'une réservation : la décision, et les envois du numéro qui ont servi à la prendre. */
export interface OtpReservation {
  decision: SendDecision;
  /** Envois comptés depuis `since`, sans la nouvelle demande. */
  recent: Date[];
}

export interface OtpChallengeRepository {
  /**
   * Enregistre une nouvelle demande, avant l'envoi, seulement si les limites du numéro le
   * permettent. La lecture des envois du numéro, la décision et l'insertion sont atomiques côté
   * base (verrou propre au numéro, tenu jusqu'à la fin de la transaction) : des demandes
   * simultanées, même sur plusieurs répliques, ne dépassent jamais les limites.
   * Comptent depuis `since` : les envois réussis (date d'envoi) et les demandes dont l'envoi n'est
   * ni réussi ni en échec (date de création). Un envoi en échec ne compte pas.
   * La demande n'est enregistrée que si `decision.allowed`.
   */
  createIfAllowed(
    challenge: OtpChallenge,
    since: Date,
    decide: (recent: Date[]) => SendDecision,
  ): Promise<OtpReservation>;
  /** Envoi réussi : canal réellement utilisé, et événement dans la même transaction. */
  markSent(id: string, channelUsed: OtpChannel, sentAt: Date, event: OtpRequestedEvent): Promise<void>;
  /** Envoi impossible : la demande devient inutilisable et ne compte pas dans les limites. */
  markSendFailed(id: string, failedAt: Date): Promise<void>;
  findById(id: string): Promise<StoredOtpChallenge | null>;
  /**
   * Prend un essai avant la comparaison, de façon atomique : renvoie le nombre d'essais, ou null si
   * la demande n'est plus utilisable (envoi manqué, consommée, expirée ou essais épuisés).
   */
  takeAttempt(id: string, maxAttempts: number, now: Date): Promise<number | null>;
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
