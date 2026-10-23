import { isDirectSendCaller } from '../../domain/caller-policy';
import { channelPlan, type ChannelName, DEFAULT_CHANNEL } from '../../domain/channel';
import { expiryOf } from '../../domain/delivery';
import { parseRecipientUserId, PhoneNumber } from '../../domain/recipient';
import { findTemplate, invalidVariables, isEventTemplate } from '../../domain/template';
import { type Clock, type IdGenerator } from '../shared/system.ports';
import { failureError, MessageDispatcher } from './message-dispatcher';
import { NotificationErrors } from './notification.errors';
import {
  type ChannelProvider,
  type NotificationRepository,
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
  private readonly dispatcher: MessageDispatcher;

  constructor(
    notifications: NotificationRepository,
    providers: readonly ChannelProvider[],
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {
    this.dispatcher = new MessageDispatcher(notifications, providers, clock);
  }

  async execute(input: SendNotificationInput): Promise<SendNotificationOutput> {
    if (input.callerService !== null && !isDirectSendCaller(input.callerService)) {
      throw NotificationErrors.callerForbidden();
    }

    // Les modèles des événements métier ne s'envoient pas par appel direct.
    const template = findTemplate(input.templateCode);
    if (!template || isEventTemplate(template)) throw NotificationErrors.templateUnknown();
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
    const outcome = await this.dispatcher.dispatch({
      notification: {
        id,
        // Sans clé, l'appel n'est pas dédoublonné : la notification est sa propre clé.
        idempotencyKey: input.idempotencyKey.trim() || id,
        templateCode: template.code,
        requestedChannel: input.channel ?? DEFAULT_CHANNEL,
        targetMasked: phone.masked(),
        recipientUserId: recipientUser.userId,
        createdAt,
        expiresAt: expiryOf(createdAt, input.ttlSeconds),
      },
      plan,
      message: {
        templateCode: template.code,
        phoneE164: phone.e164,
        email: null,
        variables: input.variables,
        content: null,
        locale: input.locale.trim() || DEFAULT_LOCALE,
      },
    });
    if (outcome.kind === 'replayed') return replay(outcome.existing);
    if (outcome.kind === 'failed') throw failureError(outcome.failure);
    return { notificationId: outcome.notificationId, channelUsed: outcome.channelUsed, status: 'accepted' };
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
