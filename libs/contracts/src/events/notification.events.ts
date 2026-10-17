/**
 * Événements publiés par notification (carte des services).
 * Source de vérité : contracts/events/notification/*.schema.json. Le test de contrat vérifie
 * que ces types et les schémas restent alignés.
 */
export type NotificationChannelName = 'sms' | 'whatsapp' | 'email' | 'push' | 'in_app';

export interface NotificationEventPayloads {
  /** Ne contient jamais le texte du message ni ses variables. */
  'notification.message.failed': {
    notificationId: string;
    templateCode: string;
    channelsTried: NotificationChannelName[];
    reason: 'provider_unavailable' | 'provider_rejected' | 'recipient_invalid' | 'ttl_expired';
    recipientUserId?: string | null;
    targetMasked: string;
  };
}

export type NotificationEventType = keyof NotificationEventPayloads;
