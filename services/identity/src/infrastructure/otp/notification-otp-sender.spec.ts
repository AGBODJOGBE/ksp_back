import { notificationV1 } from '@ksp/contracts';
import { AppError, GrpcCaller } from '@ksp/platform';
import { of, throwError } from 'rxjs';
import { PhoneNumber } from '../../domain/user/phone-number';
import { NotificationOtpSender } from './notification-otp-sender';

const target = PhoneNumber.parse('+2290197000045')!;
const input = { challengeId: 'c-1', target, channel: 'sms' as const, code: '482913', ttlSeconds: 300 };

function sender(reply: () => ReturnType<notificationV1.NotificationServiceClient['sendNotification']>) {
  const requests: notificationV1.SendNotificationRequest[] = [];
  const client: notificationV1.NotificationServiceClient = {
    sendNotification: (request) => {
      requests.push(request);
      return reply();
    },
  };
  return {
    requests,
    otpSender: new NotificationOtpSender(client, new GrpcCaller({ target: 'notification' })),
  };
}

const accepted = (channel: notificationV1.Channel) =>
  of({
    notificationId: 'n-1',
    channelUsed: channel,
    status: notificationV1.DeliveryStatus.DELIVERY_STATUS_ACCEPTED,
  });

describe('NotificationOtpSender', () => {
  it('demande le modèle identity.otp, avec bascule, idempotence et délai de validité', async () => {
    const { requests, otpSender } = sender(() => accepted(notificationV1.Channel.CHANNEL_SMS));
    await expect(otpSender.send(input)).resolves.toEqual({ channelUsed: 'sms' });
    expect(requests).toEqual([
      {
        templateCode: 'identity.otp',
        channel: notificationV1.Channel.CHANNEL_SMS,
        fallbackChannels: [notificationV1.Channel.CHANNEL_WHATSAPP],
        recipient: { userId: '', phoneE164: '+2290197000045', email: '' },
        variables: { code: '482913', expires_in_minutes: '5' },
        priority: notificationV1.Priority.PRIORITY_HIGH,
        idempotencyKey: 'c-1',
        locale: 'fr',
        ttlSeconds: 300,
      },
    ]);
  });

  it('renvoie le canal réellement utilisé après une bascule', async () => {
    const { otpSender } = sender(() => accepted(notificationV1.Channel.CHANNEL_WHATSAPP));
    await expect(otpSender.send(input)).resolves.toEqual({ channelUsed: 'whatsapp' });
  });

  it('traduit un destinataire refusé par notification en numéro invalide', async () => {
    const { otpSender } = sender(() =>
      throwError(() => AppError.invalid('NOTIFICATION_RECIPIENT_INVALID', 'Destinataire invalide.')),
    );
    await expect(otpSender.send(input)).rejects.toMatchObject({ code: 'IDENTITY_PHONE_INVALID' });
  });

  it('traduit tout autre échec en envoi impossible, sans détail interne', async () => {
    const { otpSender } = sender(() =>
      throwError(() =>
        AppError.unavailable('NOTIFICATION_CHANNELS_EXHAUSTED', 'Tous les canaux ont échoué.'),
      ),
    );
    await expect(otpSender.send(input)).rejects.toMatchObject({
      code: 'IDENTITY_OTP_SEND_FAILED',
      kind: 'UNAVAILABLE',
    });
  });

  it('considère un statut FAILED comme un envoi impossible', async () => {
    const { otpSender } = sender(() =>
      of({
        notificationId: 'n-1',
        channelUsed: notificationV1.Channel.CHANNEL_SMS,
        status: notificationV1.DeliveryStatus.DELIVERY_STATUS_FAILED,
      }),
    );
    await expect(otpSender.send(input)).rejects.toMatchObject({ code: 'IDENTITY_OTP_SEND_FAILED' });
  });
});
