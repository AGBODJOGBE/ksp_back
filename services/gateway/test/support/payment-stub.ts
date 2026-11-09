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
  customerName: '',
  organizationName: '',
  underReview: false,
  mismatchResolvedAt: '',
  mismatchResolvedBy: '',
  mismatchResolutionNote: '',
  paymentLinkId: '',
};

/** Lien de paiement vu par le payeur (ADR-040). */
export const LINK_TOKEN = 'Kq3vR9xT2mB7nY4pW8sL1cF6hJ0dG5aE3zU9iO2kX7Q';
export const protoLinkPayment: paymentV1.PublicLinkPayment = {
  id: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d5002',
  status: 'pending',
  checkoutUrl: 'https://process.fedapay.com/tok2',
  expiresAt: '2026-11-07T10:30:00.000Z',
  failureReason: '',
};
export const protoPublicLink: paymentV1.PublicPaymentLink = {
  status: 'active',
  beneficiaryName: 'SARL Bénin Immo',
  description: 'Échéance 2 sur 6',
  reference: 'REC-2026-000123 E2',
  amount: { amount: 25000, currency: 'XOF' },
  dueDate: '2026-11-30',
  expiresAt: '2026-11-14T10:00:00.000Z',
  paidAt: '',
  payment: protoLinkPayment,
};

/** Reversement (ADR-041). */
export const PAYOUT_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d6001';
export const protoPayout: paymentV1.Payout = {
  id: PAYOUT_ID,
  status: 'requested',
  issuer: 'wallet',
  reference: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d7001',
  amount: { amount: 21875, currency: 'XOF' },
  beneficiary: { phone: '+2290197000045', operator: 'mtn', name: 'SARL Bénin Immo' },
  provider: 'manual',
  providerReference: '',
  failureReason: '',
  createdAt: '2026-11-07T10:00:00.000Z',
  updatedAt: '2026-11-07T10:00:00.000Z',
  completedAt: '',
  failedAt: '',
  settledBy: '',
};

/** Écart de montant traité par la finance (ADR-032). */
export const protoResolvedMismatch: paymentV1.Payment = {
  ...protoPayment,
  status: 'amount_mismatch',
  checkoutUrl: '',
  completedAt: '2026-11-02T09:05:00.000Z',
  updatedAt: '2026-11-05T10:00:00.000Z',
  mismatchResolvedAt: '2026-11-05T10:00:00.000Z',
  mismatchResolvedBy: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e99',
  mismatchResolutionNote: 'Remboursé au client par FedaPay le 05/11.',
};

type Method =
  | keyof paymentV1.PaymentServiceController
  | keyof paymentV1.PaymentWebhookServiceController
  | keyof paymentV1.PaymentAdminServiceController
  | keyof paymentV1.PaymentLinkPublicServiceController
  | keyof paymentV1.PayoutAdminServiceController;
const CUSTOMER_METHODS: readonly Method[] = [
  'createPayment',
  'getMyPayment',
  'listMyPayments',
  'simulatePayment',
];
const WEBHOOK_METHODS: readonly Method[] = ['receiveProviderNotification'];
const LINK_METHODS: readonly Method[] = [
  'getPublicPaymentLink',
  'payPaymentLink',
  'simulatePaymentLinkPayment',
];
const PAYOUT_METHODS: readonly Method[] = ['listPayouts', 'confirmPayout', 'failPayout'];
const STAFF_STUB = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e99';

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
  listPayments: () => ({
    payments: [{ ...protoPayment, customerName: 'Koffi Adjovi', organizationName: '' }],
    nextCursor: PAYMENT_ID,
  }),
  resolveAmountMismatch: () => ({ payment: protoResolvedMismatch }),
  getPublicPaymentLink: () => ({ link: protoPublicLink }),
  payPaymentLink: () => ({ payment: protoLinkPayment, created: true }),
  simulatePaymentLinkPayment: () => ({
    payment: { ...protoLinkPayment, status: 'succeeded', checkoutUrl: '' },
  }),
  listPayouts: () => ({ payouts: [protoPayout], nextCursor: '' }),
  confirmPayout: () => ({
    payout: {
      ...protoPayout,
      status: 'completed',
      providerReference: 'MTN-TRF-0042',
      completedAt: '2026-11-07T12:00:00.000Z',
      settledBy: STAFF_STUB,
    },
  }),
  failPayout: () => ({
    payout: {
      ...protoPayout,
      status: 'failed',
      failureReason: 'Numéro inconnu chez MTN',
      failedAt: '2026-11-07T12:00:00.000Z',
      settledBy: STAFF_STUB,
    },
  }),
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
      stubController(LINK_METHODS, paymentV1.PaymentLinkPublicServiceControllerMethods),
      stubController(PAYOUT_METHODS, paymentV1.PayoutAdminServiceControllerMethods),
      stubController(
        all.filter(
          (method) =>
            ![...CUSTOMER_METHODS, ...WEBHOOK_METHODS, ...LINK_METHODS, ...PAYOUT_METHODS].includes(method),
        ),
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
