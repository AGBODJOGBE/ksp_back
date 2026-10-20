import { type AddressInfo, createServer } from 'node:net';
import { notificationV1 } from '@ksp/contracts';
import {
  AppError,
  GrpcCaller,
  grpcClientOptions,
  GrpcContextInterceptor,
  GrpcExceptionFilter,
  grpcServerOptions,
  ServiceTokenVerifier,
} from '@ksp/platform';
import { type INestMicroservice, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type ClientGrpc, ClientProxyFactory, type MicroserviceOptions } from '@nestjs/microservices';
import { createLocalJWKSet, type JSONWebKeySet } from 'jose';
// Côté appelant : le vrai client d'identity et sa chaîne de jetons de service (test de contrat entre les deux services).
import { IssueServiceTokenUseCase } from '../../identity/src/application/service-token/issue-service-token.use-case';
import { PhoneNumber } from '../../identity/src/domain/user/phone-number';
import { NotificationOtpSender } from '../../identity/src/infrastructure/otp/notification-otp-sender';
import {
  ConfigServiceClientRegistry,
  sha256Hex,
} from '../../identity/src/infrastructure/service-token/config-service-client-registry';
import { LocalServiceTokenProvider } from '../../identity/src/infrastructure/service-token/local-service-token-provider';
import {
  SystemClock as IdentityClock,
  UuidV7Generator as IdentityIds,
} from '../../identity/src/infrastructure/system/system';
import { KeyRingSigner } from '../../identity/src/infrastructure/token/key-ring-signer';
import {
  type ChannelProvider,
  type OutgoingMessage,
  type ProviderResult,
} from '../src/application/send/notification.ports';
import { SendNotificationUseCase } from '../src/application/send/send-notification.use-case';
import { InMemoryNotifications } from '../src/application/testing/fakes';
import { ConsoleWhatsAppProvider } from '../src/infrastructure/channels/console-whatsapp.provider';
import { SystemClock, UuidV7Generator } from '../src/infrastructure/system/system';
import { NotificationGrpcController } from '../src/interfaces/grpc/notification.controller';

/**
 * Bout en bout sur un vrai serveur gRPC (sans base de données) : le client d'identity
 * (NotificationOtpSender, avec ses jetons de service signés sur place) appelle notification,
 * qui vérifie le jeton avec les clés publiques d'identity, puis envoie par le prestataire console.
 */

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** Prestataire WhatsApp du test : la console par défaut, ou un résultat imposé. */
class SwitchableWhatsApp implements ChannelProvider {
  readonly channel = 'whatsapp' as const;
  readonly output: string[] = [];
  private readonly console = new ConsoleWhatsAppProvider((text) => this.output.push(text));
  next: ProviderResult | null = null;

  send(message: OutgoingMessage): Promise<ProviderResult> {
    const forced = this.next;
    this.next = null;
    return forced ? Promise.resolve(forced) : this.console.send(message);
  }
}

describe('SendNotification en gRPC : client d’identity contre le serveur notification', () => {
  let app: INestMicroservice;
  let client: notificationV1.NotificationServiceClient;
  let issuer: IssueServiceTokenUseCase;
  const whatsapp = new SwitchableWhatsApp();
  const notifications = new InMemoryNotifications();

  beforeAll(async () => {
    const signer = await KeyRingSigner.fromConfig(undefined, 'test');
    issuer = new IssueServiceTokenUseCase(
      // Carte des services volontairement trop large : notification doit refuser la gateway de lui-même.
      ConfigServiceClientRegistry.fromConfig(
        JSON.stringify({
          gateway: { secretSha256: sha256Hex('secret-gateway'), audiences: ['notification'] },
        }),
      ),
      signer,
      new IdentityIds(),
      new IdentityClock(),
      300,
    );
    const verifier = new ServiceTokenVerifier({
      audience: 'notification',
      issuer: 'ksp-identity',
      keys: createLocalJWKSet({ keys: signer.publicKeys() } as unknown as JSONWebKeySet),
    });
    const useCase = new SendNotificationUseCase(
      notifications,
      [whatsapp],
      new SystemClock(),
      new UuidV7Generator(),
    );

    @Module({
      controllers: [NotificationGrpcController],
      providers: [{ provide: SendNotificationUseCase, useValue: useCase }],
    })
    class TestModule {}

    const port = await freePort();
    app = await NestFactory.createMicroservice<MicroserviceOptions>(TestModule, {
      ...grpcServerOptions(['notification'], port),
      logger: false,
    });
    app.useGlobalFilters(new GrpcExceptionFilter());
    app.useGlobalInterceptors(new GrpcContextInterceptor(verifier));
    await app.listen();

    const grpc = ClientProxyFactory.create(
      grpcClientOptions('notification-test', 'notification', `127.0.0.1:${port}`) as never,
    ) as unknown as ClientGrpc;
    client = grpc.getService<notificationV1.NotificationServiceClient>(
      notificationV1.NOTIFICATION_SERVICE_NAME,
    );
  });

  afterAll(async () => {
    await app?.close();
  });

  const identitySender = () =>
    new NotificationOtpSender(
      client,
      new GrpcCaller({ target: 'notification', serviceTokenProvider: new LocalServiceTokenProvider(issuer) }),
    );

  const otp = (challengeId: string) => ({
    challengeId,
    target: PhoneNumber.parse('+2290197000045')!,
    channel: 'whatsapp' as const,
    code: '482913',
    ttlSeconds: 300,
  });

  it('identity envoie un code : WhatsApp accepté, code écrit dans le terminal en développement', async () => {
    await expect(identitySender().send(otp('0192f1c4-0000-7000-8000-00000000c001'))).resolves.toEqual({
      channelUsed: 'whatsapp',
    });
    expect(whatsapp.output.join('')).toContain('code=482913');
    expect(notifications.rows.at(-1)).toMatchObject({
      idempotencyKey: '0192f1c4-0000-7000-8000-00000000c001',
      status: 'accepted',
      targetMasked: '+229********45',
    });
  });

  it('le même identifiant de demande renvoyé : un seul envoi', async () => {
    const before = whatsapp.output.length;
    const rows = notifications.rows.length;
    await identitySender().send(otp('0192f1c4-0000-7000-8000-00000000c002'));
    await identitySender().send(otp('0192f1c4-0000-7000-8000-00000000c002'));
    expect(whatsapp.output.length).toBe(before + 1);
    expect(notifications.rows.length).toBe(rows + 1);
  });

  it('numéro sans WhatsApp : identity reçoit NOTIFICATION_RECIPIENT_INVALID et répond IDENTITY_PHONE_INVALID', async () => {
    whatsapp.next = { accepted: false, reason: 'recipient_invalid' };
    await expect(identitySender().send(otp('0192f1c4-0000-7000-8000-00000000c003'))).rejects.toMatchObject({
      code: 'IDENTITY_PHONE_INVALID',
    });
  });

  it('WhatsApp en panne, SMS sans prestataire : NOTIFICATION_CHANNELS_EXHAUSTED, puis IDENTITY_OTP_SEND_FAILED', async () => {
    whatsapp.next = { accepted: false, reason: 'provider_unavailable' };
    const caller = new GrpcCaller({
      target: 'notification',
      serviceTokenProvider: new LocalServiceTokenProvider(issuer),
    });
    const request: notificationV1.SendNotificationRequest = {
      templateCode: 'identity.otp',
      channel: notificationV1.Channel.CHANNEL_WHATSAPP,
      fallbackChannels: [notificationV1.Channel.CHANNEL_SMS],
      recipient: { userId: '', phoneE164: '+2290197000045', email: '' },
      variables: { code: '482913', expires_in_minutes: '5' },
      priority: notificationV1.Priority.PRIORITY_HIGH,
      idempotencyKey: '0192f1c4-0000-7000-8000-00000000c004',
      locale: 'fr',
      ttlSeconds: 300,
    };
    const error = await caller
      .call('sendNotification', (metadata) => client.sendNotification(request, metadata))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      kind: 'UNAVAILABLE',
      code: 'NOTIFICATION_CHANNELS_EXHAUSTED',
      details: { channelsTried: ['whatsapp', 'sms'] },
    });
    expect(notifications.events.at(-1)).toMatchObject({ reason: 'provider_unavailable' });

    // Même clé côté identity : l'échec est rejoué, identity le traduit pour l'utilisateur.
    await expect(identitySender().send(otp('0192f1c4-0000-7000-8000-00000000c004'))).rejects.toMatchObject({
      code: 'IDENTITY_OTP_SEND_FAILED',
    });
  });

  it('un service hors de la liste (gateway) est refusé, même avec un jeton valide', async () => {
    const gatewayToken = await issuer.execute({
      grantType: 'client_credentials',
      clientId: 'gateway',
      clientSecret: 'secret-gateway',
      audience: 'notification',
    });
    const caller = new GrpcCaller({
      target: 'notification',
      serviceTokenProvider: { getToken: async () => gatewayToken.accessToken },
    });
    const sender = new NotificationOtpSender(client, caller);
    const rows = notifications.rows.length;
    await expect(
      caller.call('sendNotification', (metadata) =>
        client.sendNotification(
          {
            templateCode: 'identity.otp',
            channel: notificationV1.Channel.CHANNEL_WHATSAPP,
            fallbackChannels: [],
            recipient: { userId: '', phoneE164: '+2290197000045', email: '' },
            variables: { code: '482913', expires_in_minutes: '5' },
            priority: notificationV1.Priority.PRIORITY_HIGH,
            idempotencyKey: '0192f1c4-0000-7000-8000-00000000c005',
            locale: 'fr',
            ttlSeconds: 300,
          },
          metadata,
        ),
      ),
    ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED', code: 'NOTIFICATION_CALLER_FORBIDDEN' });
    await expect(sender.send(otp('0192f1c4-0000-7000-8000-00000000c006'))).rejects.toMatchObject({
      code: 'IDENTITY_OTP_SEND_FAILED',
    });
    expect(notifications.rows.length).toBe(rows);
  });

  it('un appel sans jeton de service est refusé', async () => {
    const caller = new GrpcCaller({ target: 'notification' });
    await expect(
      caller.call('sendNotification', (metadata) =>
        client.sendNotification(
          { templateCode: 'identity.otp' } as notificationV1.SendNotificationRequest,
          metadata,
        ),
      ),
    ).rejects.toMatchObject({ kind: 'UNAUTHENTICATED', code: 'SERVICE_TOKEN_MISSING' });
  });
});
