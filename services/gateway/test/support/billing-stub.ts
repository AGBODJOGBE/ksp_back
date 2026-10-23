import { billingV1 } from '@ksp/contracts';
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
 * Service billing simulé pour les tests de la gateway : implémente les contrôleurs générés depuis
 * billing.proto, vérifie le jeton de service comme le vrai service, et répond des messages complets.
 */
export const INVOICE_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d7001';
const xof = (amount: number) => ({ amount, currency: 'XOF' });

export const protoInvoice: billingV1.Invoice = {
  id: INVOICE_ID,
  number: 'FAC-2026-000042',
  status: 'overdue',
  customerId: USER_ID,
  organizationId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0000',
  source: 'cleaning',
  contractId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d1000',
  periodIndex: 1,
  periodStart: '2026-11-05T08:00:00.000Z',
  periodEnd: '2026-12-05T08:00:00.000Z',
  lines: [
    {
      label: 'Prestation de nettoyage — mois 1 sur 3',
      quantity: 1,
      unitPrice: xof(160000),
      amount: xof(160000),
    },
  ],
  total: xof(160000),
  paid: xof(60000),
  balance: xof(100000),
  issuedAt: '2026-12-05T08:15:00.000Z',
  dueAt: '2026-12-15T08:15:00.000Z',
  paidAt: '',
  payments: [
    {
      id: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d7101',
      amount: xof(60000),
      method: 'cash',
      reference: '',
      recordedBy: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0001',
      recordedAt: '2026-12-16T10:00:00.000Z',
    },
  ],
};

const settings: billingV1.BillingSettings = { paymentTermDays: 10, updatedBy: '', updatedAt: '' };

type Method = keyof billingV1.BillingServiceController | keyof billingV1.BillingAdminServiceController;
const CUSTOMER_METHODS: readonly Method[] = ['listMyInvoices', 'getMyInvoice'];

const DEFAULTS: Record<Method, () => unknown> = {
  listMyInvoices: () => ({ invoices: [protoInvoice], nextCursor: '' }),
  getMyInvoice: () => ({ invoice: protoInvoice }),
  listInvoices: () => ({ invoices: [protoInvoice], nextCursor: INVOICE_ID }),
  getInvoice: () => ({ invoice: protoInvoice }),
  recordInvoicePayment: () => ({
    invoice: {
      ...protoInvoice,
      status: 'paid',
      paid: xof(160000),
      balance: xof(0),
      paidAt: '2026-12-16T11:00:00.000Z',
    },
  }),
  getBillingSettings: () => ({ settings }),
  updateBillingSettings: () => ({ settings }),
};

export class BillingStub {
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

const STUB = Symbol('BILLING_STUB');

/** Contrôleur générique : chaque méthode du contrat délègue au service simulé. */
function stubController(methods: readonly Method[], decorate: () => ClassDecorator) {
  @Controller()
  class StubController {
    constructor(@Inject(STUB) readonly stub: BillingStub) {}
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

export interface BillingServer {
  stub: BillingStub;
  url: string;
  close(): Promise<void>;
}

export async function startBillingStub(keys: TestKeys): Promise<BillingServer> {
  const stub = new BillingStub();
  const all = Object.keys(DEFAULTS) as Method[];

  @Module({
    controllers: [
      stubController(CUSTOMER_METHODS, billingV1.BillingServiceControllerMethods),
      stubController(
        all.filter((method) => !CUSTOMER_METHODS.includes(method)),
        billingV1.BillingAdminServiceControllerMethods,
      ),
    ],
    providers: [{ provide: STUB, useValue: stub }],
  })
  class StubModule {}

  const port = await freePort();
  const app: INestMicroservice = await NestFactory.createMicroservice<MicroserviceOptions>(StubModule, {
    ...grpcServerOptions(['billing'], port),
    logger: false,
  });
  app.useGlobalFilters(new GrpcExceptionFilter());
  app.useGlobalInterceptors(
    new GrpcContextInterceptor(
      new ServiceTokenVerifier({
        audience: 'billing',
        issuer: 'ksp-identity',
        keys: createLocalJWKSet(keys.serviceJwks),
      }),
    ),
  );
  await app.listen();
  return { stub, url: `127.0.0.1:${port}`, close: () => app.close() };
}
