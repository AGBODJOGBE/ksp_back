import { type AppError } from '@ksp/platform';
import { isDirectSendCaller } from '../../domain/caller-policy';
import { channelPlan, type ChannelName, DEFAULT_CHANNEL } from '../../domain/channel';
import { type ChannelAttempt, expiryOf, isExpired, summarizeFailure } from '../../domain/delivery';
import { parseRecipientUserId, PhoneNumber } from '../../domain/recipient';
import { findTemplate, invalidVariables } from '../../domain/template';
import { type Clock, type IdGenerator } from '../shared/system.ports';
import { NotificationErrors } from './notification.errors';
import {
  type ChannelProvider,
  type NotificationRepository,
  type OutgoingMessage,
  type ProviderResult,
  type StoredNotification,
} from './notification.ports';

export interface SendNotificationInput {
  /**
   * Service appelant, lu dans son jeton de service vérifié. null : aucun vérificateur configuré
   * (développement uniquement, le kit l'interdit en production).
   */
  callerService: string | null;
  templateCode: string;
  /** null : canal non précisé, WhatsApp par défaut. */
  channel: ChannelName | null;
  fallbackChannels: ChannelName[];
  recipient: { userId: string; phoneE164: string };
  variables: Record<string, string>;
  idempotencyKey: string;
  locale: string;
  ttlSeconds: number;
}

export interface SendNotificationOutput {
  notificationId: string;
  channelUsed: ChannelName;
  /** Toujours `accepted` : pris en charge par le prestataire, remise non encore confirmée (ADR-021). */
  status: 'accepted';
}

const DEFAULT_LOCALE = 'fr';

/**
 * Envoi direct d'une notification (contrat SendNotification) : codes de connexion d'identity
 * (ADR-014), puis codes de signature de document.
 *
 * - Idempotent : deux appels avec la même clé ne produisent qu'un envoi, le second reçoit la réponse du premier.
 * - Canal demandé (WhatsApp par défaut), puis les canaux de bascule dans l'ordre ; un canal sans
 *   prestataire configuré est sauté (aucun prestataire SMS au lancement, ADR-021).
 * - Au-delà de `ttlSeconds` après l'appel, plus aucun canal n'est essayé.
 * - Échec de tous les canaux : statut et événement notification.message.failed dans la même transaction.
 */
export class SendNotificationUseCase {
  private readonly providers: ReadonlyMap<ChannelName, ChannelProvider>;

  constructor(
    private readonly notifications: NotificationRepository,
    providers: readonly ChannelProvider[],
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {
    this.providers = new Map(providers.map((provider) => [provider.channel, provider]));
  }

  async execute(input: SendNotificationInput): Promise<SendNotificationOutput> {
    if (input.callerService !== null && !isDirectSendCaller(input.callerService)) {
      throw NotificationErrors.callerForbidden();
    }

    const template = findTemplate(input.templateCode);
    if (!template) throw NotificationErrors.templateUnknown();
    const plan = channelPlan(input.channel, input.fallbackChannels, template.channels);
    if (plan.length === 0) throw NotificationErrors.templateUnknown();

    // Au lot 1, les modèles ne partent que par des canaux téléphoniques : le numéro est obligatoire.
    const phone = PhoneNumber.parse(input.recipient.phoneE164);
    const recipientUser = parseRecipientUserId(input.recipient.userId);
    if (!phone || !recipientUser.valid) throw NotificationErrors.recipientInvalid();

    const invalid = invalidVariables(template, input.variables);
    if (invalid.length > 0) throw NotificationErrors.variablesInvalid(invalid);

    const createdAt = this.clock.now();
    const id = this.ids.next();
    const notification = {
      id,
      // Sans clé, l'appel n'est pas dédoublonné : la notification est sa propre clé.
      idempotencyKey: input.idempotencyKey.trim() || id,
      templateCode: template.code,
      requestedChannel: input.channel ?? DEFAULT_CHANNEL,
      targetMasked: phone.masked(),
      recipientUserId: recipientUser.userId,
      createdAt,
      expiresAt: expiryOf(createdAt, input.ttlSeconds),
    };
    const claim = await this.notifications.claim(notification);
    if (!claim.created) return replay(claim.existing);

    const attempts: ChannelAttempt[] = [];
    let ttlExpired = false;
    for (const channel of plan) {
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
      const result = await send(provider, {
        notificationId: id,
        channel,
        templateCode: template.code,
        phoneE164: phone.e164,
        variables: input.variables,
        locale: input.locale.trim() || DEFAULT_LOCALE,
      });
      if (result.accepted) {
        await this.notifications.markAccepted(id, {
          channelUsed: channel,
          channelsTried: [...attempts.map((attempt) => attempt.channel), channel],
          providerMessageId: result.providerMessageId,
          at: this.clock.now(),
        });
        return { notificationId: id, channelUsed: channel, status: 'accepted' };
      }
      attempts.push({ channel, outcome: 'failed', reason: result.reason });
    }

    const failure = summarizeFailure(attempts, ttlExpired);
    const error: AppError = failure.recipientRejected
      ? NotificationErrors.recipientInvalid()
      : NotificationErrors.channelsExhausted(failure.channelsTried);
    await this.notifications.markFailed(
      id,
      {
        channelsTried: failure.channelsTried,
        reason: failure.reason,
        errorCode: error.code,
        at: this.clock.now(),
      },
      {
        notificationId: id,
        templateCode: template.code,
        channelsTried: failure.channelsTried,
        reason: failure.reason,
        recipientUserId: recipientUser.userId,
        targetMasked: notification.targetMasked,
      },
    );
    throw error;
  }
}

/** Un prestataire qui lève malgré tout une erreur est traité comme indisponible : on passe au canal suivant. */
async function send(provider: ChannelProvider, message: OutgoingMessage): Promise<ProviderResult> {
  try {
    return await provider.send(message);
  } catch {
    return { accepted: false, reason: 'provider_unavailable' };
  }
}

/** Second appel avec la même clé : la réponse du premier, sans nouvel envoi. */
function replay(existing: StoredNotification): SendNotificationOutput {
  if (existing.status === 'accepted' && existing.channelUsed) {
    return { notificationId: existing.id, channelUsed: existing.channelUsed, status: 'accepted' };
  }
  if (existing.status === 'failed') {
    throw existing.errorCode === 'NOTIFICATION_RECIPIENT_INVALID'
      ? NotificationErrors.recipientInvalid()
      : NotificationErrors.channelsExhausted(existing.channelsTried);
  }
  throw NotificationErrors.alreadyInProgress();
}
