import { notificationV1 } from '@ksp/contracts';
import { AppError, GrpcCaller } from '@ksp/platform';
import { of, throwError } from 'rxjs';
import { EmailAddress } from '../../domain/user/email-address';
import { NotificationEmailCodeSender } from './notification-email-code-sender';

const input = {
  verificationId: 'v-1',
  userId: '0192f1c4-0000-7000-8000-000000000001',
  email: EmailAddress.parse('koffi@exemple.com')!,
  code: '482913',
  ttlSeconds: 900,
};

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
    emailSender: new NotificationEmailCodeSender(client, new GrpcCaller({ target: 'notification' })),
  };
}

describe('NotificationEmailCodeSender', () => {
  it('demande le modèle identity.email_verification par e-mail seul, idempotent et limité dans le temps', async () => {
    const { requests, emailSender } = sender(() =>
      of({
        notificationId: 'n-1',
        channelUsed: notificationV1.Channel.CHANNEL_EMAIL,
        status: notificationV1.DeliveryStatus.DELIVERY_STATUS_ACCEPTED,
      }),
    );
    await expect(emailSender.send(input)).resolves.toBeUndefined();
    expect(requests).toEqual([
      {
        templateCode: 'identity.email_verification',
        channel: notificationV1.Channel.CHANNEL_EMAIL,
        fallbackChannels: [],
        recipient: { userId: input.userId, phoneE164: '', email: 'koffi@exemple.com' },
        variables: { code: '482913', expires_in_minutes: '15' },
        priority: notificationV1.Priority.PRIORITY_HIGH,
        idempotencyKey: 'v-1',
        locale: 'fr',
        ttlSeconds: 900,
      },
    ]);
  });

  it('traduit une adresse refusée par notification en adresse invalide', async () => {
    const { emailSender } = sender(() =>
      throwError(() => AppError.invalid('NOTIFICATION_RECIPIENT_INVALID', 'Destinataire invalide.')),
    );
    await expect(emailSender.send(input)).rejects.toMatchObject({ code: 'IDENTITY_EMAIL_INVALID' });
  });

  it('toute autre panne devient un envoi impossible, sans détail interne', async () => {
    const { emailSender } = sender(() =>
      throwError(() =>
        AppError.unavailable('NOTIFICATION_CHANNELS_EXHAUSTED', 'Tous les canaux ont échoué.'),
      ),
    );
    await expect(emailSender.send(input)).rejects.toMatchObject({ code: 'IDENTITY_OTP_SEND_FAILED' });
  });
});
