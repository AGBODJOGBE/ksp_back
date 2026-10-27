import { notificationV1 } from '@ksp/contracts';
import { runWithContext } from '@ksp/platform';
import {
  type SendNotificationInput,
  type SendNotificationUseCase,
} from '../../application/send/send-notification.use-case';
import { NotificationGrpcController } from './notification.controller';

function controller(channelUsed: 'whatsapp' | 'sms' = 'whatsapp') {
  const inputs: SendNotificationInput[] = [];
  const useCase = {
    execute: async (input: SendNotificationInput) => {
      inputs.push(input);
      return { notificationId: 'n-1', channelUsed, status: 'accepted' as const };
    },
  } as unknown as SendNotificationUseCase;
  return { inputs, grpc: new NotificationGrpcController(useCase) };
}

const request = (
  overrides: Partial<notificationV1.SendNotificationRequest> = {},
): notificationV1.SendNotificationRequest => ({
  templateCode: 'identity.otp',
  channel: notificationV1.Channel.CHANNEL_WHATSAPP,
  fallbackChannels: [notificationV1.Channel.CHANNEL_SMS],
  recipient: { userId: '', phoneE164: '+2290197000045', email: '' },
  variables: { code: '482913', expires_in_minutes: '5' },
  priority: notificationV1.Priority.PRIORITY_HIGH,
  idempotencyKey: 'c-1',
  locale: 'fr',
  ttlSeconds: 300,
  ...overrides,
});

describe('NotificationGrpcController.sendNotification', () => {
  it('transmet la demande et le service appelant vérifié, puis répond ACCEPTED', async () => {
    const { inputs, grpc } = controller();
    const response = await runWithContext({ correlationId: 'corr-1', callerService: 'identity' }, () =>
      grpc.sendNotification(request()),
    );
    expect(inputs).toEqual([
      {
        callerService: 'identity',
        templateCode: 'identity.otp',
        channel: 'whatsapp',
        fallbackChannels: ['sms'],
        recipient: { userId: '', phoneE164: '+2290197000045', email: '' },
        variables: { code: '482913', expires_in_minutes: '5' },
        idempotencyKey: 'c-1',
        locale: 'fr',
        ttlSeconds: 300,
      },
    ]);
    expect(response).toEqual({
      notificationId: 'n-1',
      channelUsed: notificationV1.Channel.CHANNEL_WHATSAPP,
      status: notificationV1.DeliveryStatus.DELIVERY_STATUS_ACCEPTED,
    });
  });

  it('sans vérificateur de jetons (développement), l’appelant est inconnu', async () => {
    const { inputs, grpc } = controller();
    await grpc.sendNotification(request());
    expect(inputs[0]).toMatchObject({ callerService: null });
  });

  it('canal non précisé, bascules non reconnues et destinataire absent', async () => {
    const { inputs, grpc } = controller('sms');
    const response = await grpc.sendNotification(
      request({
        channel: notificationV1.Channel.CHANNEL_UNSPECIFIED,
        fallbackChannels: [notificationV1.Channel.UNRECOGNIZED, notificationV1.Channel.CHANNEL_EMAIL],
        recipient: undefined,
      }),
    );
    expect(inputs[0]).toMatchObject({
      channel: null,
      fallbackChannels: ['email'],
      recipient: { userId: '', phoneE164: '', email: '' },
    });
    expect(response.channelUsed).toBe(notificationV1.Channel.CHANNEL_SMS);
  });
});
