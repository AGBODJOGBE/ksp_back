import { type CleaningEventPayloads } from './cleaning.events';
import { type IdentityEventPayloads } from './identity.events';
import { type NotificationEventPayloads } from './notification.events';

export * from './cleaning.events';
export * from './envelope';
export * from './identity.events';
export * from './notification.events';

/** Tous les événements connus de l'écosystème : type → contenu. Complété à chaque nouveau service. */
export type KspEventPayloads = IdentityEventPayloads & NotificationEventPayloads & CleaningEventPayloads;
export type KspEventType = keyof KspEventPayloads;
