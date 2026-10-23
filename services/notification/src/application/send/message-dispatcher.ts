import { type ChannelName } from '../../domain/channel';
import {
  type ChannelAttempt,
  type DeliveryFailure,
  isExpired,
  summarizeFailure,
} from '../../domain/delivery';
import { type Clock } from '../shared/system.ports';
import { NotificationErrors } from './notification.errors';
import {
  type ChannelProvider,
  type NewNotification,
  type NotificationRepository,
  type OutgoingMessage,
  type ProviderResult,
  type StoredNotification,
} from './notification.ports';

export interface DispatchRequest {
  /** Notification à enregistrer avant tout envoi (clé d'idempotence comprise). */
  notification: NewNotification;
  /** Canaux à essayer, dans l'ordre. */
  plan: readonly ChannelName[];
  /** Contenu commun à tous les canaux. */
  message: Omit<OutgoingMessage, 'notificationId' | 'channel'>;
}

export type DispatchOutcome =
  | { kind: 'accepted'; notificationId: string; channelUsed: ChannelName }
  | { kind: 'failed'; notificationId: string; failure: DeliveryFailure }
  /** Clé d'idempotence déjà vue : rien n'est envoyé, la notification enregistrée est rendue. */
  | { kind: 'replayed'; existing: StoredNotification };

/**
 * Envoi d'un message par le premier canal qui l'accepte, partagé par l'envoi direct
 * (SendNotification) et les notifications déclenchées par les événements.
 *
 * - Idempotent : la notification est enregistrée avant l'envoi ; une clé déjà vue n'envoie rien.
 * - Un canal sans prestataire configuré est sauté (aucun prestataire SMS au lancement, ADR-021).
 * - Au-delà de la date d'expiration, plus aucune bascule n'est essayée.
 * - Échec de tous les canaux : statut et événement notification.message.failed dans la même transaction.
 */
export class MessageDispatcher {
  private readonly providers: ReadonlyMap<ChannelName, ChannelProvider>;

  constructor(
    private readonly notifications: NotificationRepository,
    providers: readonly ChannelProvider[],
    private readonly clock: Clock,
  ) {
    this.providers = new Map(providers.map((provider) => [provider.channel, provider]));
  }

  async dispatch(request: DispatchRequest): Promise<DispatchOutcome> {
    const { notification } = request;
    const claim = await this.notifications.claim(notification);
    if (!claim.created) return { kind: 'replayed', existing: claim.existing };

    const attempts: ChannelAttempt[] = [];
    let ttlExpired = false;
    for (const channel of request.plan) {
      // Le premier canal part au moment de l'appel ; le délai ne peut arrêter que les bascules.
      if (attempts.length > 0 && isExpired(notification.expiresAt, this.clock.now())) {
        ttlExpired = true;
        break;
      }
      const provider = this.providers.get(channel);
      if (!provider) {
        attempts.push({ channel, outcome: 'skipped' });
        continue;
      }
      const result = await send(provider, { ...request.message, notificationId: notification.id, channel });
      if (result.accepted) {
        await this.notifications.markAccepted(notification.id, {
          channelUsed: channel,
          channelsTried: [...attempts.map((attempt) => attempt.channel), channel],
          providerMessageId: result.providerMessageId,
          at: this.clock.now(),
        });
        return { kind: 'accepted', notificationId: notification.id, channelUsed: channel };
      }
      attempts.push({ channel, outcome: 'failed', reason: result.reason });
    }

    const failure = summarizeFailure(attempts, ttlExpired);
    await this.notifications.markFailed(
      notification.id,
      {
        channelsTried: failure.channelsTried,
        reason: failure.reason,
        errorCode: failureError(failure).code,
        at: this.clock.now(),
      },
      {
        notificationId: notification.id,
        templateCode: notification.templateCode,
        channelsTried: failure.channelsTried,
        reason: failure.reason,
        recipientUserId: notification.recipientUserId,
        targetMasked: notification.targetMasked,
      },
    );
    return { kind: 'failed', notificationId: notification.id, failure };
  }
}

/** Erreur rendue à l'appelant direct pour un échec de tous les canaux. */
export function failureError(failure: DeliveryFailure) {
  return failure.recipientRejected
    ? NotificationErrors.recipientInvalid()
    : NotificationErrors.channelsExhausted(failure.channelsTried);
}

/** Un prestataire qui lève malgré tout une erreur est traité comme indisponible : on passe au canal suivant. */
async function send(provider: ChannelProvider, message: OutgoingMessage): Promise<ProviderResult> {
  try {
    return await provider.send(message);
  } catch {
    return { accepted: false, reason: 'provider_unavailable' };
  }
}
