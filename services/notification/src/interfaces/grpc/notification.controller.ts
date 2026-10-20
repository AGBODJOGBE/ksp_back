import { notificationV1 } from '@ksp/contracts';
import { currentContext } from '@ksp/platform';
import { Controller } from '@nestjs/common';
import { SendNotificationUseCase } from '../../application/send/send-notification.use-case';
import { type ChannelName } from '../../domain/channel';

const CHANNEL_IN: Partial<Record<notificationV1.Channel, ChannelName>> = {
  [notificationV1.Channel.CHANNEL_SMS]: 'sms',
  [notificationV1.Channel.CHANNEL_WHATSAPP]: 'whatsapp',
  [notificationV1.Channel.CHANNEL_EMAIL]: 'email',
  [notificationV1.Channel.CHANNEL_PUSH]: 'push',
  [notificationV1.Channel.CHANNEL_IN_APP]: 'in_app',
};

const CHANNEL_OUT: Record<ChannelName, notificationV1.Channel> = {
  sms: notificationV1.Channel.CHANNEL_SMS,
  whatsapp: notificationV1.Channel.CHANNEL_WHATSAPP,
  email: notificationV1.Channel.CHANNEL_EMAIL,
  push: notificationV1.Channel.CHANNEL_PUSH,
  in_app: notificationV1.Channel.CHANNEL_IN_APP,
};

/**
 * Adaptateur gRPC : traduit l'appel et délègue au cas d'usage. Aucune règle métier ici.
 * Ne journalise jamais la requête : ses variables peuvent contenir un code (ADR-014).
 */
@Controller()
@notificationV1.NotificationServiceControllerMethods()
export class NotificationGrpcController implements notificationV1.NotificationServiceController {
  constructor(private readonly sendNotificationUseCase: SendNotificationUseCase) {}

  async sendNotification(
    request: notificationV1.SendNotificationRequest,
  ): Promise<notificationV1.SendNotificationResponse> {
    const result = await this.sendNotificationUseCase.execute({
      // Renseigné par le kit après vérification du jeton de service ; absent sans vérificateur (développement).
      callerService: currentContext()?.callerService ?? null,
      templateCode: request.templateCode,
      channel: CHANNEL_IN[request.channel] ?? null,
      fallbackChannels: request.fallbackChannels.flatMap((channel) => CHANNEL_IN[channel] ?? []),
      recipient: { userId: request.recipient?.userId ?? '', phoneE164: request.recipient?.phoneE164 ?? '' },
      variables: request.variables,
      idempotencyKey: request.idempotencyKey,
      locale: request.locale,
      ttlSeconds: request.ttlSeconds,
    });
    return {
      notificationId: result.notificationId,
      channelUsed: CHANNEL_OUT[result.channelUsed],
      // Jamais SENT sans accusé de remise (ADR-021).
      status: notificationV1.DeliveryStatus.DELIVERY_STATUS_ACCEPTED,
    };
  }
}
