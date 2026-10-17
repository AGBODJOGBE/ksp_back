import { notificationV1 } from '@ksp/contracts';
import { AppError, type GrpcCaller } from '@ksp/platform';
import { type OtpSender } from '../../application/otp/otp.ports';
import { fallbackChannel, type OtpChannel } from '../../domain/otp/otp-challenge';
import { type PhoneNumber } from '../../domain/user/phone-number';

const TO_NOTIFICATION: Record<OtpChannel, notificationV1.Channel> = {
  sms: notificationV1.Channel.CHANNEL_SMS,
  whatsapp: notificationV1.Channel.CHANNEL_WHATSAPP,
};

function fromNotification(channel: notificationV1.Channel, requested: OtpChannel): OtpChannel {
  if (channel === notificationV1.Channel.CHANNEL_WHATSAPP) return 'whatsapp';
  if (channel === notificationV1.Channel.CHANNEL_SMS) return 'sms';
  return requested;
}

const sendFailed = () =>
  AppError.unavailable(
    'IDENTITY_OTP_SEND_FAILED',
    "Le code n'a pas pu être envoyé. Réessayez dans quelques instants.",
  );

/**
 * Envoie le code par appel gRPC direct à notification (ADR-014), avec bascule automatique
 * sur l'autre canal. L'appel n'est jamais rejoué automatiquement : la clé d'idempotence
 * (identifiant de la demande) garantit un seul envoi.
 */
export class NotificationOtpSender implements OtpSender {
  constructor(
    private readonly client: notificationV1.NotificationServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async send(input: {
    challengeId: string;
    target: PhoneNumber;
    channel: OtpChannel;
    code: string;
    ttlSeconds: number;
  }): Promise<{ channelUsed: OtpChannel }> {
    const request: notificationV1.SendNotificationRequest = {
      templateCode: 'identity.otp',
      channel: TO_NOTIFICATION[input.channel],
      fallbackChannels: [TO_NOTIFICATION[fallbackChannel(input.channel)]],
      recipient: { userId: '', phoneE164: input.target.e164, email: '' },
      variables: { code: input.code, expires_in_minutes: String(Math.ceil(input.ttlSeconds / 60)) },
      priority: notificationV1.Priority.PRIORITY_HIGH,
      idempotencyKey: input.challengeId,
      locale: 'fr',
      ttlSeconds: input.ttlSeconds,
    };

    let response: notificationV1.SendNotificationResponse;
    try {
      response = await this.caller.call('sendNotification', (metadata) =>
        this.client.sendNotification(request, metadata),
      );
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOTIFICATION_RECIPIENT_INVALID') {
        throw AppError.invalid('IDENTITY_PHONE_INVALID', 'Ce numéro ne peut pas recevoir de code.');
      }
      throw sendFailed();
    }
    if (response.status === notificationV1.DeliveryStatus.DELIVERY_STATUS_FAILED) throw sendFailed();
    return { channelUsed: fromNotification(response.channelUsed, input.channel) };
  }
}
