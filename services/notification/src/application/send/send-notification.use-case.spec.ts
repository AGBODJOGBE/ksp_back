import { AppError } from '@ksp/platform';
import { FakeProvider, FixedClock, InMemoryNotifications, SequentialIds } from '../testing/fakes';
import { type SendNotificationInput, SendNotificationUseCase } from './send-notification.use-case';

const NOW = new Date('2026-10-20T12:00:00Z');
const USER_ID = '0192f1c4-0000-7000-8000-000000000001';

const otp = (overrides: Partial<SendNotificationInput> = {}): SendNotificationInput => ({
  callerService: 'identity',
  templateCode: 'identity.otp',
  channel: 'whatsapp',
  fallbackChannels: ['sms'],
  recipient: { userId: '', phoneE164: '+2290197000045' },
  variables: { code: '482913', expires_in_minutes: '5' },
  idempotencyKey: 'challenge-1',
  locale: 'fr',
  ttlSeconds: 300,
  ...overrides,
});

function setup(providers: FakeProvider[] = [new FakeProvider('whatsapp')]) {
  const notifications = new InMemoryNotifications();
  const clock = new FixedClock(NOW);
  const useCase = new SendNotificationUseCase(notifications, providers, clock, new SequentialIds());
  return { notifications, clock, useCase, providers };
}

describe('SendNotificationUseCase — envoi accepté', () => {
  it('envoie le code par WhatsApp et répond ACCEPTED avec le canal utilisé', async () => {
    const whatsapp = new FakeProvider('whatsapp', [{ accepted: true, providerMessageId: 'wamid.1' }]);
    const { notifications, useCase } = setup([whatsapp]);

    await expect(useCase.execute(otp())).resolves.toEqual({
      notificationId: '0192f1c4-7a2b-7c3d-8e4f-000000000001',
      channelUsed: 'whatsapp',
      status: 'accepted',
    });
    expect(whatsapp.sent).toEqual([
      {
        notificationId: '0192f1c4-7a2b-7c3d-8e4f-000000000001',
        channel: 'whatsapp',
        templateCode: 'identity.otp',
        phoneE164: '+2290197000045',
        email: null,
        variables: { code: '482913', expires_in_minutes: '5' },
        content: null,
        locale: 'fr',
      },
    ]);
    expect(notifications.events).toEqual([]);
  });

  it('n’enregistre ni le texte ni les variables d’un modèle secret, seulement le destinataire masqué', async () => {
    const { notifications, useCase } = setup([
      new FakeProvider('whatsapp', [{ accepted: true, providerMessageId: 'wamid.1' }]),
    ]);
    await useCase.execute(otp());
    expect(notifications.rows).toEqual([
      {
        id: '0192f1c4-7a2b-7c3d-8e4f-000000000001',
        idempotencyKey: 'challenge-1',
        templateCode: 'identity.otp',
        requestedChannel: 'whatsapp',
        targetMasked: '+229********45',
        recipientUserId: null,
        createdAt: NOW,
        expiresAt: new Date('2026-10-20T12:05:00Z'),
        status: 'accepted',
        channelUsed: 'whatsapp',
        channelsTried: ['whatsapp'],
        providerMessageId: 'wamid.1',
        errorCode: null,
        failureReason: null,
        acceptedAt: NOW,
        failedAt: null,
      },
    ]);
    expect(JSON.stringify(notifications.rows)).not.toContain('482913');
    expect(JSON.stringify(notifications.rows)).not.toContain('0197000045');
  });

  it('utilise WhatsApp quand le canal n’est pas précisé, et le français par défaut', async () => {
    const { providers, useCase } = setup();
    await expect(
      useCase.execute(otp({ channel: null, fallbackChannels: [], locale: ' ' })),
    ).resolves.toMatchObject({ channelUsed: 'whatsapp' });
    expect(providers[0]!.sent[0]).toMatchObject({ locale: 'fr' });
  });

  it('saute le SMS demandé, faute de prestataire (ADR-021), et bascule sur WhatsApp', async () => {
    const { notifications, useCase } = setup();
    await expect(
      useCase.execute(otp({ channel: 'sms', fallbackChannels: ['whatsapp'] })),
    ).resolves.toMatchObject({
      channelUsed: 'whatsapp',
    });
    expect(notifications.rows[0]).toMatchObject({
      requestedChannel: 'sms',
      channelsTried: ['sms', 'whatsapp'],
    });
  });

  it('bascule sur le canal suivant quand le premier prestataire échoue', async () => {
    const sms = new FakeProvider('sms', [{ accepted: false, reason: 'provider_unavailable' }]);
    const whatsapp = new FakeProvider('whatsapp');
    const { useCase } = setup([sms, whatsapp]);
    await expect(
      useCase.execute(otp({ channel: 'sms', fallbackChannels: ['whatsapp'] })),
    ).resolves.toMatchObject({
      channelUsed: 'whatsapp',
    });
    expect(sms.sent).toHaveLength(1);
    expect(whatsapp.sent).toHaveLength(1);
  });

  it('un prestataire qui lève une erreur est traité comme indisponible', async () => {
    const sms = new FakeProvider('sms', [new Error('socket hang up')]);
    const { useCase } = setup([sms, new FakeProvider('whatsapp')]);
    await expect(
      useCase.execute(otp({ channel: 'sms', fallbackChannels: ['whatsapp'] })),
    ).resolves.toMatchObject({
      channelUsed: 'whatsapp',
    });
  });

  it('garde l’identifiant de compte du destinataire, s’il est fourni', async () => {
    const { notifications, useCase } = setup();
    await useCase.execute(otp({ recipient: { userId: USER_ID, phoneE164: '+2290197000045' } }));
    expect(notifications.rows[0]).toMatchObject({ recipientUserId: USER_ID });
  });
});

describe('SendNotificationUseCase — idempotence', () => {
  it('deux appels avec la même clé : un seul envoi, la seconde réponse est celle du premier', async () => {
    const whatsapp = new FakeProvider('whatsapp');
    const { notifications, useCase } = setup([whatsapp]);
    const first = await useCase.execute(otp());
    const second = await useCase.execute(otp());
    expect(second).toEqual(first);
    expect(whatsapp.sent).toHaveLength(1);
    expect(notifications.rows).toHaveLength(1);
  });

  it('rejoue l’échec du premier appel, sans nouvel envoi ni nouvel événement', async () => {
    const whatsapp = new FakeProvider('whatsapp', [{ accepted: false, reason: 'provider_unavailable' }]);
    const { notifications, useCase } = setup([whatsapp]);
    await expect(useCase.execute(otp())).rejects.toMatchObject({ code: 'NOTIFICATION_CHANNELS_EXHAUSTED' });
    await expect(useCase.execute(otp())).rejects.toMatchObject({
      code: 'NOTIFICATION_CHANNELS_EXHAUSTED',
      details: { channelsTried: ['whatsapp', 'sms'] },
    });
    expect(whatsapp.sent).toHaveLength(1);
    expect(notifications.events).toHaveLength(1);
  });

  it('rejoue un destinataire refusé', async () => {
    const { useCase } = setup([
      new FakeProvider('whatsapp', [{ accepted: false, reason: 'recipient_invalid' }]),
    ]);
    await expect(useCase.execute(otp())).rejects.toMatchObject({ code: 'NOTIFICATION_RECIPIENT_INVALID' });
    await expect(useCase.execute(otp())).rejects.toMatchObject({ code: 'NOTIFICATION_RECIPIENT_INVALID' });
  });

  it('refuse un second appel pendant que le premier est en cours, sans renvoyer', async () => {
    const { notifications, useCase, providers } = setup();
    await notifications.claim({
      id: 'n-0',
      idempotencyKey: 'challenge-1',
      templateCode: 'identity.otp',
      requestedChannel: 'whatsapp',
      targetMasked: '+229********45',
      recipientUserId: null,
      createdAt: NOW,
      expiresAt: null,
    });
    await expect(useCase.execute(otp())).rejects.toMatchObject({
      code: 'NOTIFICATION_ALREADY_IN_PROGRESS',
      kind: 'CONFLICT',
    });
    expect(providers[0]!.sent).toHaveLength(0);
  });

  it('sans clé, chaque appel est un envoi distinct', async () => {
    const { notifications, useCase } = setup();
    await useCase.execute(otp({ idempotencyKey: '' }));
    await useCase.execute(otp({ idempotencyKey: ' ' }));
    expect(notifications.rows.map((row) => row.idempotencyKey)).toEqual([
      '0192f1c4-7a2b-7c3d-8e4f-000000000001',
      '0192f1c4-7a2b-7c3d-8e4f-000000000002',
    ]);
  });
});

describe('SendNotificationUseCase — échecs', () => {
  it('tous les canaux échouent : NOTIFICATION_CHANNELS_EXHAUSTED et événement sans code ni numéro', async () => {
    const whatsapp = new FakeProvider('whatsapp', [{ accepted: false, reason: 'provider_rejected' }]);
    const { notifications, useCase } = setup([whatsapp]);

    const error = await useCase
      .execute(otp({ recipient: { userId: USER_ID, phoneE164: '+2290197000045' } }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'NOTIFICATION_CHANNELS_EXHAUSTED',
      kind: 'UNAVAILABLE',
      details: { channelsTried: ['whatsapp', 'sms'] },
    });
    expect(notifications.rows[0]).toMatchObject({
      status: 'failed',
      errorCode: 'NOTIFICATION_CHANNELS_EXHAUSTED',
      failureReason: 'provider_rejected',
      channelUsed: null,
    });
    expect(notifications.events).toEqual([
      {
        notificationId: '0192f1c4-7a2b-7c3d-8e4f-000000000001',
        templateCode: 'identity.otp',
        channelsTried: ['whatsapp', 'sms'],
        reason: 'provider_rejected',
        recipientUserId: USER_ID,
        targetMasked: '+229********45',
      },
    ]);
  });

  it('aucun prestataire pour aucun canal : échec « prestataire indisponible »', async () => {
    const { notifications, useCase } = setup([]);
    await expect(useCase.execute(otp({ channel: 'sms', fallbackChannels: [] }))).rejects.toMatchObject({
      code: 'NOTIFICATION_CHANNELS_EXHAUSTED',
      details: { channelsTried: ['sms'] },
    });
    expect(notifications.events[0]).toMatchObject({ reason: 'provider_unavailable', channelsTried: ['sms'] });
  });

  it('numéro refusé par WhatsApp (sans compte WhatsApp), SMS absent : NOTIFICATION_RECIPIENT_INVALID', async () => {
    const { notifications, useCase } = setup([
      new FakeProvider('whatsapp', [{ accepted: false, reason: 'recipient_invalid' }]),
    ]);
    await expect(useCase.execute(otp())).rejects.toMatchObject({
      code: 'NOTIFICATION_RECIPIENT_INVALID',
      kind: 'INVALID_ARGUMENT',
    });
    expect(notifications.rows[0]).toMatchObject({ status: 'failed', failureReason: 'recipient_invalid' });
    expect(notifications.events[0]).toMatchObject({ reason: 'recipient_invalid' });
  });

  it('délai dépassé avant la bascule : la bascule n’est pas tentée (ttl_expired)', async () => {
    const { clock, notifications } = setup();
    const sms = new FakeProvider('sms', [
      () => {
        clock.advance(301);
        return { accepted: false, reason: 'provider_unavailable' };
      },
    ]);
    const whatsapp = new FakeProvider('whatsapp');
    const slow = new SendNotificationUseCase(notifications, [sms, whatsapp], clock, new SequentialIds());

    await expect(slow.execute(otp({ channel: 'sms', fallbackChannels: ['whatsapp'] }))).rejects.toMatchObject(
      {
        code: 'NOTIFICATION_CHANNELS_EXHAUSTED',
        details: { channelsTried: ['sms'] },
      },
    );
    expect(whatsapp.sent).toHaveLength(0);
    expect(notifications.events[0]).toMatchObject({ reason: 'ttl_expired', channelsTried: ['sms'] });
  });

  it('sans limite (ttl 0), la bascule est toujours tentée', async () => {
    const { clock, notifications } = setup();
    const sms = new FakeProvider('sms', [
      () => {
        clock.advance(3600);
        return { accepted: false, reason: 'provider_unavailable' };
      },
    ]);
    const useCase = new SendNotificationUseCase(
      notifications,
      [sms, new FakeProvider('whatsapp')],
      clock,
      new SequentialIds(),
    );
    await expect(
      useCase.execute(otp({ channel: 'sms', fallbackChannels: ['whatsapp'], ttlSeconds: 0 })),
    ).resolves.toMatchObject({ channelUsed: 'whatsapp' });
    expect(notifications.rows[0]).toMatchObject({ expiresAt: null });
  });
});

describe('SendNotificationUseCase — refus avant tout envoi', () => {
  const rejects = async (input: SendNotificationInput, expected: Record<string, unknown>) => {
    const { notifications, providers, useCase } = setup();
    await expect(useCase.execute(input)).rejects.toMatchObject(expected);
    expect(notifications.rows).toHaveLength(0);
    expect(providers[0]!.sent).toHaveLength(0);
  };

  it('modèle inconnu : NOTIFICATION_TEMPLATE_UNKNOWN', () =>
    rejects(otp({ templateCode: 'identity.welcome' }), {
      code: 'NOTIFICATION_TEMPLATE_UNKNOWN',
      kind: 'NOT_FOUND',
    }));

  it('modèle réservé aux événements métier : NOTIFICATION_TEMPLATE_UNKNOWN', () =>
    rejects(otp({ templateCode: 'cleaning.quote_sent.customer' }), {
      code: 'NOTIFICATION_TEMPLATE_UNKNOWN',
    }));

  it('modèle inexistant pour les canaux demandés : NOTIFICATION_TEMPLATE_UNKNOWN', () =>
    rejects(otp({ channel: 'email', fallbackChannels: ['push'] }), {
      code: 'NOTIFICATION_TEMPLATE_UNKNOWN',
    }));

  it.each(['', '0197000045', '+229'])('numéro %p : NOTIFICATION_RECIPIENT_INVALID', (phoneE164) =>
    rejects(otp({ recipient: { userId: '', phoneE164 } }), {
      code: 'NOTIFICATION_RECIPIENT_INVALID',
      kind: 'INVALID_ARGUMENT',
    }),
  );

  it('identifiant de compte mal formé : NOTIFICATION_RECIPIENT_INVALID', () =>
    rejects(otp({ recipient: { userId: 'u-1', phoneE164: '+2290197000045' } }), {
      code: 'NOTIFICATION_RECIPIENT_INVALID',
    }));

  it('variables manquantes : NOTIFICATION_VARIABLES_INVALID, avec leurs noms seulement', () =>
    rejects(otp({ variables: { code: '482913' } }), {
      code: 'NOTIFICATION_VARIABLES_INVALID',
      details: { invalidVariables: ['expires_in_minutes'] },
    }));

  it.each(['gateway', 'payment'])(
    'service %s non autorisé : NOTIFICATION_CALLER_FORBIDDEN',
    (callerService) =>
      rejects(otp({ callerService }), { code: 'NOTIFICATION_CALLER_FORBIDDEN', kind: 'PERMISSION_DENIED' }),
  );

  it.each(['identity', 'document', null])('appelant %p accepté', async (callerService) => {
    const { useCase } = setup();
    await expect(useCase.execute(otp({ callerService }))).resolves.toMatchObject({ status: 'accepted' });
  });
});
