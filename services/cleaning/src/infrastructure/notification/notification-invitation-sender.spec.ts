import { notificationV1 } from '@ksp/contracts';
import { AppError, BlindIndex, GrpcCaller } from '@ksp/platform';
import { of, throwError } from 'rxjs';
import { InvitationSendFailedError } from '../../application/agents/agent.ports';
import { BlindIndexPhoneFingerprints } from '../crypto/phone-fingerprints';
import { NotificationInvitationSender } from './notification-invitation-sender';

const INVITATION = '0192f1c4-0000-7000-8000-0000000000b1';
const INPUT = {
  invitationId: INVITATION,
  attempt: 1,
  phone: '+2290197000045',
  // 28 novembre à 00 h 30 à Porto-Novo.
  expiresAt: new Date('2026-11-27T23:30:00Z'),
};
const ACCEPTED = {
  notificationId: 'n1',
  channelUsed: notificationV1.Channel.CHANNEL_WHATSAPP,
  status: notificationV1.DeliveryStatus.DELIVERY_STATUS_ACCEPTED,
};

function adapter(answer: () => unknown) {
  const requests: notificationV1.SendNotificationRequest[] = [];
  const client = {
    sendNotification: (request: notificationV1.SendNotificationRequest) => {
      requests.push(request);
      return answer();
    },
  } as unknown as notificationV1.NotificationServiceClient;
  return {
    requests,
    sender: new NotificationInvitationSender(
      client,
      new GrpcCaller({ target: 'notification', retryBackoffMs: 1 }),
      'https://agent.ksp.test/',
    ),
  };
}

describe('NotificationInvitationSender (notification.SendNotification, R-AG-02)', () => {
  it('modèle cleaning.agent_invitation, WhatsApp puis SMS, lien et date limite ; une clé par tentative', async () => {
    const { sender, requests } = adapter(() => of(ACCEPTED));
    await sender.send(INPUT);
    await sender.send({ ...INPUT, attempt: 2 });
    expect(requests[0]).toEqual({
      templateCode: 'cleaning.agent_invitation',
      channel: notificationV1.Channel.CHANNEL_WHATSAPP,
      fallbackChannels: [notificationV1.Channel.CHANNEL_SMS],
      recipient: { userId: '', phoneE164: '+2290197000045', email: '' },
      variables: { link: `https://agent.ksp.test/invitations/${INVITATION}`, expires_on: '28/11/2026' },
      priority: notificationV1.Priority.PRIORITY_NORMAL,
      idempotencyKey: `cleaning:agent_invitation:${INVITATION}:1`,
      locale: 'fr',
      ttlSeconds: 0,
    });
    expect(requests.map((request) => request.idempotencyKey)).toEqual([
      `cleaning:agent_invitation:${INVITATION}:1`,
      `cleaning:agent_invitation:${INVITATION}:2`,
    ]);
  });

  it('notification injoignable ou envoi déjà en cours : NOTIFICATION_UNAVAILABLE, même tentative à rejouer', async () => {
    const down = adapter(() =>
      throwError(() => new AppError('UNAVAILABLE', 'GRPC_UNAVAILABLE', 'notification injoignable')),
    );
    await expect(down.sender.send(INPUT)).rejects.toMatchObject({
      kind: 'UNAVAILABLE',
      code: 'NOTIFICATION_UNAVAILABLE',
    });
    // Appel idempotent par sa clé : une nouvelle tentative avant de rendre la panne.
    expect(down.requests).toHaveLength(2);
    const busy = adapter(() =>
      throwError(() => AppError.conflict('NOTIFICATION_ALREADY_IN_PROGRESS', 'Envoi en cours.')),
    );
    await expect(busy.sender.send(INPUT)).rejects.toMatchObject({ code: 'NOTIFICATION_UNAVAILABLE' });
  });

  it('tous les canaux en échec : InvitationSendFailedError, la tentative est terminée', async () => {
    const exhausted = adapter(() =>
      throwError(() => AppError.unavailable('NOTIFICATION_CHANNELS_EXHAUSTED', 'Aucun canal.')),
    );
    await expect(exhausted.sender.send(INPUT)).rejects.toBeInstanceOf(InvitationSendFailedError);
    const failed = adapter(() =>
      of({ ...ACCEPTED, status: notificationV1.DeliveryStatus.DELIVERY_STATUS_FAILED }),
    );
    await expect(failed.sender.send(INPUT)).rejects.toBeInstanceOf(InvitationSendFailedError);
  });

  it('autre refus de notification : transmis tel quel', async () => {
    const refused = adapter(() =>
      throwError(() => AppError.invalid('NOTIFICATION_RECIPIENT_INVALID', 'Destinataire mal formé.')),
    );
    await expect(refused.sender.send(INPUT)).rejects.toMatchObject({
      kind: 'INVALID_ARGUMENT',
      code: 'NOTIFICATION_RECIPIENT_INVALID',
    });
    expect(refused.requests).toHaveLength(1);
  });
});

describe('BlindIndexPhoneFingerprints (empreinte à clé du numéro invité)', () => {
  const KEY_A = Buffer.alloc(32, 1).toString('base64');
  const KEY_B = Buffer.alloc(32, 2).toString('base64');
  const fingerprints = (key: string) =>
    new BlindIndexPhoneFingerprints(BlindIndex.fromConfig(key, 'test', 'CLEANING_BLIND_INDEX_KEYS'));

  it('même empreinte pour toutes les formes d’un numéro, autre empreinte avec une autre clé', () => {
    const fingerprint = fingerprints(KEY_A).invitationPhone('+229 97 00 00 45');
    expect(fingerprint).toBe(fingerprints(KEY_A).invitationPhone('+2290197000045'));
    expect(fingerprint).not.toBe(fingerprints(KEY_A).invitationPhone('+2290197000046'));
    expect(fingerprint).not.toBe(fingerprints(KEY_B).invitationPhone('+2290197000045'));
    expect(fingerprint).not.toContain('97000045');
  });
});
