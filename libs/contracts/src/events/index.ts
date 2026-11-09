import { type BillingEventPayloads } from './billing.events';
import { type CleaningEventPayloads } from './cleaning.events';
import { type IdentityEventPayloads } from './identity.events';
import { type NotificationEventPayloads } from './notification.events';
import { type PaymentEventPayloads } from './payment.events';
import { type WalletEventPayloads } from './wallet.events';

export * from './billing.events';
export * from './cleaning.events';
export * from './envelope';
export * from './identity.events';
export * from './notification.events';
export * from './payment.events';
export * from './wallet.events';

/** Tous les événements connus de l'écosystème : type → contenu. Complété à chaque nouveau service. */
export type KspEventPayloads = IdentityEventPayloads &
  NotificationEventPayloads &
  CleaningEventPayloads &
  BillingEventPayloads &
  PaymentEventPayloads &
  WalletEventPayloads;
export type KspEventType = keyof KspEventPayloads;
