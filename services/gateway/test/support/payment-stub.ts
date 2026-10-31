import { paymentV1 } from '@ksp/contracts';
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
 * Service payment simulé pour les tests de la gateway : implémente les contrôleurs générés depuis
 * payment.proto, vérifie le jeton de service comme le vrai service, et répond des messages complets.
 */
export const PAYMENT_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d5001';
export const MISSION_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d1000';

export const protoPayment: paymentV1.Payment = {
  id: PAYMENT_ID,
  status: 'pending',
  subject: { type: 'cleaning_mission', id: MISSION_ID, part: 'deposit', reference: '' },
  amount: { amount: 15000, currency: 'XOF' },
  customerId: USER_ID,
  organizationId: '',
  method: 'mobile_money_online',
  provider: 'fedapay',
  providerReference: '',
  checkoutUrl: 'https://process.fedapay.com/tok',
  failureReason: '',
  createdAt: '2026-11-02T09:00:00.000Z',
  updatedAt: '2026-11-02T09:00:01.000Z',
  expiresAt: '2026-11-02T09:30:00.000Z',
  completedAt: '',
};

type Method =
  | keyof paymentV1.PaymentServiceController
  | keyof paymentV1.PaymentWebhookServiceController
  | keyof paymentV1.PaymentAdminServiceController;
const CUSTOMER_METHODS: readonly Method[] = [
  'createPayment',
  'getMyPayment',
  'listMyPayments',
  'simulatePayment',
];
const WEBHOOK_METHODS: readonly Method[] = ['receiveProviderNotification'];

const DEFAULTS: Record<Method, () => unknown> = {
  createPayment: () => ({ payment: protoPayment, created: true }),
  getMyPayment: () => ({ payment: protoPayment }),
  listMyPayments: () => ({ payments: [protoPayment], nextCursor: '' }),
  simulatePayment: () => ({
    payment: {
      ...protoPayment,
      status: 'succeeded',
      checkoutUrl: '',
      completedAt: '2026-11-02T09:05:00.000Z',
    },
  }),
  receiveProviderNotification: () => ({ outcome: 'applied' }),
  listPayments: () => ({ payments: [protoPayment], nextCursor: PAYMENT_ID }),
};

export class PaymentStub {
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
    return (override ? await override({ ...request }) : DEFAULTS[method]()) as never;
  }
}

const STUB = Symbol('PAYMENT_STUB');

/** Contrôleur générique : chaque méthode du contrat délègue au service simulé. */
function stubController(methods: readonly Method[], decorate: () => ClassDecorator) {
  @Controller()
  class StubController {
    constructor(@Inject(STUB) readonly stub: PaymentStub) {}
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

export interface PaymentServer {
  stub: PaymentStub;
  url: string;
  close(): Promise<void>;
}

export async function startPaymentStub(keys: TestKeys): Promise<PaymentServer> {
  const stub = new PaymentStub();
  const all = Object.keys(DEFAULTS) as Method[];

  @Module({
    controllers: [
      stubController(CUSTOMER_METHODS, paymentV1.PaymentServiceControllerMethods),
      stubController(WEBHOOK_METHODS, paymentV1.PaymentWebhookServiceControllerMethods),
      stubController(
        all.filter((method) => !CUSTOMER_METHODS.includes(method) && !WEBHOOK_METHODS.includes(method)),
        paymentV1.PaymentAdminServiceControllerMethods,
      ),
    ],
    providers: [{ provide: STUB, useValue: stub }],
  })
  class StubModule {}

  const port = await freePort();
  const app: INestMicroservice = await NestFactory.createMicroservice<MicroserviceOptions>(StubModule, {
    ...grpcServerOptions(['payment'], port),
    logger: false,
  });
  app.useGlobalFilters(new GrpcExceptionFilter());
  app.useGlobalInterceptors(
    new GrpcContextInterceptor(
      new ServiceTokenVerifier({
        audience: 'payment',
        issuer: 'ksp-identity',
        keys: createLocalJWKSet(keys.serviceJwks),
      }),
    ),
  );
  await app.listen();
  return { stub, url: `127.0.0.1:${port}`, close: () => app.close() };
}
