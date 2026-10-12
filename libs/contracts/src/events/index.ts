import { type IdentityEventPayloads } from './identity.events';

export * from './envelope';
export * from './identity.events';

/** Tous les événements connus de l'écosystème : type → contenu. Complété à chaque nouveau service. */
export type KspEventPayloads = IdentityEventPayloads;
export type KspEventType = keyof KspEventPayloads;
