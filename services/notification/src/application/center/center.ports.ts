import { type ChannelName } from '../../domain/channel';
import { type NotificationStatus } from '../../domain/delivery';
import { type ChannelPreferences } from '../../domain/preferences';

/** Une page demandée : taille bornée et curseur (identifiant du dernier élément reçu). */
export interface PageRequest {
  limit: number;
  cursor: string | null;
}

export interface PageResult<T> {
  items: T[];
  nextCursor: string | null;
}

/** Notification de l'espace KSP telle qu'enregistrée (table in_app_notifications). */
export interface StoredInAppNotification {
  id: string;
  userId: string;
  templateCode: string;
  title: string;
  body: string;
  link: string | null;
  createdAt: Date;
  readAt: Date | null;
}

/**
 * Notifications de l'espace KSP d'un compte. Chaque lecture et chaque écriture est limitée au
 * compte donné : une notification d'un autre compte est introuvable.
 */
export interface InAppNotificationStore {
  /** Les plus récentes d'abord (date, puis identifiant) ; curseur inconnu ou d'un autre compte : page vide. */
  list(
    userId: string,
    page: PageRequest,
    filter: { unreadOnly: boolean },
  ): Promise<PageResult<StoredInAppNotification>>;
  countUnread(userId: string): Promise<number>;
  /** Marque lue si elle ne l'est pas (date de lecture gardée sinon) ; null si introuvable pour ce compte. */
  markRead(userId: string, id: string, at: Date): Promise<StoredInAppNotification | null>;
  /** Nombre de notifications marquées lues par cet appel. */
  markAllRead(userId: string, at: Date): Promise<number>;
}

export interface StoredPreferences extends ChannelPreferences {
  /** null : jamais modifiées (valeurs par défaut). */
  updatedAt: Date | null;
}

/** Préférences de canaux (table notification_preferences, une ligne par compte qui a choisi). */
export interface PreferencesStore {
  /** Valeurs par défaut si le compte n'a rien choisi. */
  get(userId: string): Promise<StoredPreferences>;
  save(userId: string, preferences: ChannelPreferences, at: Date): Promise<StoredPreferences>;
  /** Préférences de plusieurs comptes ; un compte absent du résultat garde les valeurs par défaut. */
  findMany(userIds: readonly string[]): Promise<Map<string, ChannelPreferences>>;
}

/** Un envoi de l'historique (table notifications), sans texte ni variables (ADR-014). */
export interface DeliveryRecord {
  id: string;
  templateCode: string;
  requestedChannel: ChannelName;
  channelUsed: ChannelName | null;
  channelsTried: ChannelName[];
  targetMasked: string;
  recipientUserId: string | null;
  status: NotificationStatus;
  errorCode: string | null;
  failureReason: string | null;
  providerMessageId: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  acceptedAt: Date | null;
  failedAt: Date | null;
  /** Historique détaché d'un compte supprimé (clé d'idempotence `erased:<id>`, ADR-036). */
  erased: boolean;
}

export interface DeliveryFilters {
  templateCode: string | null;
  /** Canal essayé (présent dans channels_tried). */
  channel: ChannelName | null;
  status: NotificationStatus | null;
  /** Bornes d'envoi : [from, to[. */
  from: Date | null;
  to: Date | null;
  recipientUserId: string | null;
}

/** Historique des envois, en lecture seule (back-office). */
export interface DeliveryHistory {
  /** Les plus récents d'abord (date, puis identifiant). */
  list(filters: DeliveryFilters, page: PageRequest): Promise<PageResult<DeliveryRecord>>;
  find(id: string): Promise<DeliveryRecord | null>;
}

/**
 * Préférences des destinataires d'un événement (ADR-039) : sous-ensemble du dépôt utile à
 * l'envoi des messages.
 */
export type RecipientPreferences = Pick<PreferencesStore, 'findMany'>;
