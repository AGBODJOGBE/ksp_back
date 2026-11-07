import { notificationV1 } from '@ksp/contracts';
import {
  currentContext,
  GrpcContextInterceptor,
  GrpcExceptionFilter,
  grpcServerOptions,
  type RequestContext,
  ServiceTokenVerifier,
} from '@ksp/platform';
import { Controller, Inject, type INestMicroservice, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type MicroserviceOptions } from '@nestjs/microservices';
import { createLocalJWKSet } from 'jose';
import { freePort, type TestKeys, USER_ID } from './harness';

/**
 * Service notification simulé pour les tests de la gateway (centre de notifications, ADR-039) :
 * implémente les contrôleurs générés depuis notification.proto, vérifie le jeton de service comme
 * le vrai service, et répond des messages complets.
 */
export const NOTIFICATION_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d6001';
export const DELIVERY_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d6101';

export const protoInAppNotification: notificationV1.InAppNotification = {
  id: NOTIFICATION_ID,
  templateCode: 'cleaning.quote_sent.customer',
  title: 'Votre devis de nettoyage — Vitres',
  body: 'Bonjour Koffi,\nVotre devis est prêt : 150 000 FCFA.',
  link: 'https://ksp.bj/mon-espace/nettoyage/demandes/0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d1001',
  createdAt: '2026-11-05T09:30:00.000Z',
  readAt: '',
};

export const protoDelivery: notificationV1.Delivery = {
  id: DELIVERY_ID,
  templateCode: 'cleaning.quote_requested.customer',
  requestedChannel: 'whatsapp',
  channelUsed: '',
  channelsTried: ['whatsapp', 'email'],
  targetMasked: '+229********45',
  recipientUserId: USER_ID,
  status: 'failed',
  errorCode: 'NOTIFICATION_CHANNELS_EXHAUSTED',
  failureReason: 'provider_unavailable',
  providerMessageId: '',
  createdAt: '2026-11-05T09:30:00.000Z',
  expiresAt: '',
  acceptedAt: '',
  failedAt: '2026-11-05T09:30:02.000Z',
  erased: false,
};

const preferences: notificationV1.NotificationPreferences = { whatsapp: true, email: true, updatedAt: '' };

type Method =
  | keyof notificationV1.InAppNotificationServiceController
  | keyof notificationV1.NotificationAdminServiceController;
const CENTER_METHODS: readonly Method[] = [
  'listMyNotifications',
  'countMyUnreadNotifications',
  'markNotificationRead',
  'markAllNotificationsRead',
  'getMyNotificationPreferences',
  'updateMyNotificationPreferences',
];

const DEFAULTS: Record<Method, (request: Record<string, unknown>) => unknown> = {
  listMyNotifications: () => ({ notifications: [protoInAppNotification], nextCursor: '', unreadCount: 1 }),
  countMyUnreadNotifications: () => ({ unreadCount: 3 }),
  markNotificationRead: () => ({
    notification: { ...protoInAppNotification, readAt: '2026-11-07T10:00:00.000Z' },
    unreadCount: 0,
  }),
  markAllNotificationsRead: () => ({ marked: 2, unreadCount: 0 }),
  getMyNotificationPreferences: () => ({ preferences }),
  updateMyNotificationPreferences: (request) => ({
    preferences: {
      whatsapp: request['whatsapp'],
      email: request['email'],
      updatedAt: '2026-11-07T10:00:00.000Z',
    },
  }),
  listDeliveries: () => ({ deliveries: [protoDelivery], nextCursor: DELIVERY_ID }),
  getDelivery: () => ({ delivery: protoDelivery }),
  listMessageTemplates: () => ({
    templates: [
      {
        code: 'identity.otp',
        kind: 'direct',
        channels: ['whatsapp', 'sms'],
        secret: true,
        optional: false,
        variables: ['code', 'expires_in_minutes'],
        optionalVariables: [],
        subject: '',
        text: '',
      },
      {
        code: 'billing.invoice_issued.customer',
        kind: 'document',
        channels: ['whatsapp', 'email'],
        secret: false,
        optional: true,
        variables: ['first_name', 'invoice_number'],
        optionalVariables: [],
        subject: 'Votre facture {invoice_number}',
        text: 'Bonjour {first_name},',
      },
    ],
  }),
};

export class NotificationStub {
  readonly calls: {
    method: Method;
    request: Record<string, unknown>;
    context: RequestContext | undefined;
  }[] = [];
  private readonly overrides = new Map<Method, (request: Record<string, unknown>) => Promise<unknown>>();

  on(method: Method, handler: (request: Record<string, unknown>) => Promise<unknown>): void {
    this.overrides.set(method, handler);
  }

  reset(): void {
    this.overrides.clear();
    this.calls.length = 0;
  }

  last(method: Method) {
    return this.calls.filter((call) => call.method === method).at(-1);
  }

  async handle(method: Method, request: object): Promise<never> {
    this.calls.push({ method, request: { ...request }, context: currentContext() });
    const override = this.overrides.get(method);
    return (override ? await override({ ...request }) : DEFAULTS[method]({ ...request })) as never;
  }
}

const STUB = Symbol('NOTIFICATION_STUB');

/** Contrôleur générique : chaque méthode du contrat délègue au service simulé. */
function stubController(methods: readonly Method[], decorate: () => ClassDecorator) {
  @Controller()
  class StubController {
    constructor(@Inject(STUB) readonly stub: NotificationStub) {}
  }
  for (const method of methods) {
    Object.defineProperty(StubController.prototype, method, {
      value(this: StubController, request: object) {
        return this.stub.handle(method, request);
      },
    });
  }
  decorate()(StubController);
  return StubController;
}

export interface NotificationServer {
  stub: NotificationStub;
  url: string;
  close(): Promise<void>;
}

export async function startNotificationStub(keys: TestKeys): Promise<NotificationServer> {
  const stub = new NotificationStub();
  const all = Object.keys(DEFAULTS) as Method[];

  @Module({
    controllers: [
      stubController(CENTER_METHODS, notificationV1.InAppNotificationServiceControllerMethods),
      stubController(
        all.filter((method) => !CENTER_METHODS.includes(method)),
        notificationV1.NotificationAdminServiceControllerMethods,
      ),
    ],
    providers: [{ provide: STUB, useValue: stub }],
  })
  class StubModule {}

  const port = await freePort();
  const app: INestMicroservice = await NestFactory.createMicroservice<MicroserviceOptions>(StubModule, {
    ...grpcServerOptions(['notification'], port),
    logger: false,
  });
  app.useGlobalFilters(new GrpcExceptionFilter());
  app.useGlobalInterceptors(
    new GrpcContextInterceptor(
      new ServiceTokenVerifier({
        audience: 'notification',
        issuer: 'ksp-identity',
        keys: createLocalJWKSet(keys.serviceJwks),
      }),
    ),
  );
  await app.listen();
  return { stub, url: `127.0.0.1:${port}`, close: () => app.close() };
}
