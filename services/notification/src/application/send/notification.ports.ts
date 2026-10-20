import { type ChannelName } from '../../domain/channel';
import {
  type FailureReason,
  type NotificationStatus,
  type ProviderFailureReason,
} from '../../domain/delivery';

/**
 * Notification enregistrée avant tout envoi. Ne contient jamais le texte ni les variables du
 * modèle (un code de connexion ne doit apparaître ni en base ni dans un journal, ADR-014).
 */
export interface NewNotification {
  id: string;
  idempotencyKey: string;
  templateCode: string;
  requestedChannel: ChannelName;
  targetMasked: string;
  recipientUserId: string | null;
  createdAt: Date;
  expiresAt: Date | null;
}

/** Ce qu'il faut savoir d'une notification déjà enregistrée pour répondre à un second appel. */
export interface StoredNotification {
  id: string;
  status: NotificationStatus;
  channelUsed: ChannelName | null;
  channelsTried: ChannelName[];
  errorCode: string | null;
}

/** Événement notification.message.failed, écrit dans l'outbox avec la mise à jour du statut. */
export interface NotificationFailedEvent {
  notificationId: string;
  templateCode: string;
  channelsTried: ChannelName[];
  reason: FailureReason;
  recipientUserId: string | null;
  targetMasked: string;
}

export type ClaimResult = { created: true } | { created: false; existing: StoredNotification };

export interface NotificationRepository {
  /**
   * Enregistre la notification (statut `pending`) si sa clé d'idempotence est nouvelle ; sinon
   * renvoie la notification déjà enregistrée sous cette clé. Atomique : de deux appels simultanés
   * avec la même clé, un seul obtient `created: true`.
   */
  claim(notification: NewNotification): Promise<ClaimResult>;
  /** Le prestataire a pris le message en charge. */
  markAccepted(
    id: string,
    accepted: { channelUsed: ChannelName; channelsTried: ChannelName[]; providerMessageId: string; at: Date },
  ): Promise<void>;
  /** Tous les canaux ont échoué : statut et événement dans la même transaction (outbox). */
  markFailed(
    id: string,
    failed: { channelsTried: ChannelName[]; reason: FailureReason; errorCode: string; at: Date },
    event: NotificationFailedEvent,
  ): Promise<void>;
}

/** Message remis à un prestataire. Les variables ne vivent qu'en mémoire, le temps de l'envoi. */
export interface OutgoingMessage {
  notificationId: string;
  channel: ChannelName;
  templateCode: string;
  phoneE164: string;
  variables: Readonly<Record<string, string>>;
  locale: string;
}

export type ProviderResult =
  { accepted: true; providerMessageId: string } | { accepted: false; reason: ProviderFailureReason };

/**
 * Port « fournisseur de canal » (ADR-021) : un prestataire par canal, remplaçable sans toucher
 * au reste du service. Un prestataire ne lève pas d'erreur : il rend un refus qualifié.
 */
export interface ChannelProvider {
  readonly channel: ChannelName;
  send(message: OutgoingMessage): Promise<ProviderResult>;
}
