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
  organization: {
    legalName: 'SARL Bénin Propre',
    address: 'Lot 12, Haie Vive, Cotonou',
    ifu: '3201912345678',
    rccm: '',
  },
};

const settings: billingV1.BillingSettings = { paymentTermDays: 10, updatedBy: '', updatedAt: '' };

/** Recouvrement (ADR-064) : facture de commission d'une organisation, commission à débiter encore due. */
export const COMMISSION_INVOICE_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d7301';
export const protoCommissionInvoice: billingV1.CommissionInvoice = {
  id: COMMISSION_INVOICE_ID,
  number: 'FCR-2026-000007',
  status: 'pending_payment',
  creditor: { type: 'organization', id: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0000' },
  period: '2026-11',
  periodStart: '2026-10-31T23:00:00.000Z',
  periodEnd: '2026-11-30T23:00:00.000Z',
  lines: [
    {
      caseId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d5000',
      caseNumber: 'RC-000123',
      collectionId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d5101',
      receivedAt: '2026-11-04T10:00:00.000Z',
      receivedOn: '2026-11-04',
      source: 'direct_to_creditor',
      gross: xof(60000),
      commission: xof(9000),
      settlement: 'invoiced',
    },
  ],
  totalCollected: xof(60000),
  commissionDeducted: xof(0),
  commissionInvoiced: xof(9000),
  commissionTotal: xof(9000),
  balance: xof(9000),
  amountsExcludingTax: true,
  issuedAt: '2026-11-30T23:00:00.000Z',
  paidAt: '',
  walletTransactionId: '',
  debit: {
    attempts: 1,
    lastAttemptAt: '2026-11-30T23:00:00.000Z',
    nextAttemptAt: '2026-12-01T23:00:00.000Z',
    lastFailure: 'insufficient_funds',
    missing: xof(5000),
  },
  organization: {
    legalName: 'SARL Bénin Propre',
    address: 'Lot 12, Haie Vive, Cotonou',
    ifu: '3201912345678',
    rccm: '',
  },
};

export const protoFeeReceipt: billingV1.FeeReceipt = {
  id: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d7401',
  number: 'RFD-2026-000012',
  kind: 'case_fee',
  payer: { type: 'user', id: USER_ID },
  caseId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d5000',
  caseNumber: 'RC-000123',
  label: 'Frais de dossier RC-000123',
  amount: xof(25000),
  paidAt: '2026-11-03T09:00:00.000Z',
  issuedAt: '2026-11-03T09:00:02.000Z',
  walletTransactionId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d7501',
};

type Method = keyof billingV1.BillingServiceController | keyof billingV1.BillingAdminServiceController;
const CUSTOMER_METHODS: readonly Method[] = [
  'listMyInvoices',
  'getMyInvoice',
  'payMyInvoiceFromWallet',
  'payMyInvoiceByMobileMoney',
  'getMyBillingPreferences',
  'updateMyBillingPreferences',
  'listMyCommissionInvoices',
  'getMyCommissionInvoice',
  'listMyFeeReceipts',
];

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
  payMyInvoiceFromWallet: () => ({
    invoice: {
      ...protoInvoice,
      status: 'paid',
      paid: xof(160000),
      balance: xof(0),
      paidAt: '2026-12-16T11:00:00.000Z',
    },
  }),
  // Méthodes du contrat v2 pas encore routées par la gateway : réponse vide.
  payMyInvoiceByMobileMoney: () => ({}),
  getMyBillingPreferences: () => ({}),
  updateMyBillingPreferences: () => ({}),
  issueAdminCreditNote: () => ({}),
  listCreditNotes: () => ({}),
  // Recouvrement (ADR-064).
  listMyCommissionInvoices: () => ({ commissionInvoices: [protoCommissionInvoice], nextCursor: '' }),
  getMyCommissionInvoice: () => ({ commissionInvoice: protoCommissionInvoice }),
  listMyFeeReceipts: () => ({ receipts: [protoFeeReceipt], nextCursor: '' }),
  listCommissionInvoices: () => ({
    commissionInvoices: [protoCommissionInvoice],
    nextCursor: COMMISSION_INVOICE_ID,
  }),
  getCommissionInvoice: () => ({ commissionInvoice: protoCommissionInvoice }),
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
