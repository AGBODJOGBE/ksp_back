import { type AddressInfo, createServer } from 'node:net';
import { billingV1 } from '@ksp/contracts';
import {
  type AppError,
  GrpcCaller,
  grpcClientOptions,
  GrpcContextInterceptor,
  GrpcExceptionFilter,
  grpcServerOptions,
  runWithContext,
} from '@ksp/platform';
import { type INestMicroservice, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type ClientGrpc, ClientProxyFactory, type MicroserviceOptions } from '@nestjs/microservices';
import { type Metadata } from '@grpc/grpc-js';
import { type Observable } from 'rxjs';
import { createMonthlyUseCases, MONTHLY_USE_CASES } from '../src/application/monthly/use-cases';
import { CUSTOMER_ID, testWorld } from '../src/application/testing/fakes';
import { FakeWalletCredits, InMemoryMonthly } from '../src/application/testing/monthly-fakes';
import { recoveryTestWorld } from '../src/application/testing/recovery-fakes';
import {
  createRecoveryBillingUseCases,
  RECOVERY_BILLING_USE_CASES,
} from '../src/application/recovery/use-cases';
import { BILLING_USE_CASES, createUseCases } from '../src/application/use-cases';
import {
  BillingGrpcController,
  InvoiceIssuanceGrpcController,
} from '../src/interfaces/grpc/billing.controller';

/**
 * Lot E, bout en bout sur un vrai serveur gRPC (doublures en mémoire, sans base) : facture de séance
 * émise au paiement par cleaning (InvoiceIssuanceService.IssueInvoice), champs v2 présentés, puis
 * relue dans « Mes factures ».
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

const SESSION_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d5001';
const DEBIT_ID = '0192f1c4-0000-7000-d000-000000000001';
const xof = (amount: number) => ({ amount, currency: 'XOF' });

describe('émission des factures de séance en gRPC', () => {
  let app: INestMicroservice;
  let issuance: billingV1.InvoiceIssuanceServiceClient;
  let invoices: billingV1.BillingServiceClient;
  const caller = new GrpcCaller({ target: 'billing' });

  beforeAll(async () => {
    const world = testWorld();
    @Module({
      controllers: [BillingGrpcController, InvoiceIssuanceGrpcController],
      providers: [
        { provide: BILLING_USE_CASES, useValue: createUseCases(world) },
        // Lot F : les avoirs passent par le même contrôleur d'émission.
        {
          provide: MONTHLY_USE_CASES,
          useValue: createMonthlyUseCases({
            ...world,
            monthly: new InMemoryMonthly(world.invoices, world.recorder),
            walletCredits: new FakeWalletCredits(),
          }),
        },
        // Recouvrement (ADR-064) : même contrôleur de l'espace client.
        { provide: RECOVERY_BILLING_USE_CASES, useValue: createRecoveryBillingUseCases(recoveryTestWorld()) },
        GrpcContextInterceptor,
      ],
    })
    class TestModule {}

    const port = await freePort();
    app = await NestFactory.createMicroservice<MicroserviceOptions>(TestModule, {
      ...grpcServerOptions(['billing'], port),
      logger: false,
    });
    app.useGlobalFilters(new GrpcExceptionFilter());
    app.useGlobalInterceptors(app.get(GrpcContextInterceptor));
    await app.listen();
    const client = ClientProxyFactory.create(
      grpcClientOptions('c', 'billing', `127.0.0.1:${port}`) as never,
    ) as unknown as ClientGrpc;
    issuance = client.getService(billingV1.INVOICE_ISSUANCE_SERVICE_NAME);
    invoices = client.getService(billingV1.BILLING_SERVICE_NAME);
  });

  afterAll(async () => {
    await app?.close();
  });

  /** Appel au nom du client (contexte personnel), comme le transmet la gateway. */
  const call = <T>(invoke: (metadata: Metadata) => Observable<T>): Promise<T> =>
    runWithContext(
      {
        correlationId: '0192f1c4-0000-7000-8000-00000000c0de',
        user: {
          userId: CUSTOMER_ID,
          sessionId: 's',
          activeContext: 'personal',
          roles: [{ role: 'customer', scopeType: 'global' as const }],
          mfa: false,
          authTime: Math.floor(Date.now() / 1000),
        },
      },
      () => caller.call('test', invoke),
    );

  const request: billingV1.IssueInvoiceRequest = {
    idempotencyKey: `cleaning_session_invoice:${SESSION_ID}`,
    kind: 'session',
    customerId: CUSTOMER_ID,
    organizationId: '',
    sourceObject: { objectType: 'cleaning_session', objectId: SESSION_ID },
    requestNumber: 'DN-2026-000012',
    programNumber: 'PN-2026-000007',
    sessionRank: '3/15',
    placeLabel: 'Maison de Cocotomey',
    serviceDate: '2026-12-04',
    lines: [
      {
        label: 'Nettoyage — séance 3/15',
        quantity: 1,
        unitPrice: xof(15_000),
        amount: xof(15_000),
        kind: 'session',
        serviceDate: '2026-12-04',
      },
    ],
    payment: {
      method: 'wallet',
      reference: DEBIT_ID,
      amount: xof(15_000),
      paidAt: '2026-12-04T17:30:00.000Z',
    },
  };

  it('facture payée, champs v2 présentés, rejeu sans doublon, clé réutilisée refusée', async () => {
    const first = await call((m) => issuance.issueInvoice(request, m));
    expect(first.created).toBe(true);
    const expected = {
      number: 'FAC-2026-000001',
      status: 'paid',
      contractId: '',
      periodIndex: 0,
      kind: 'session',
      sourceObject: { objectType: 'cleaning_session', objectId: SESSION_ID },
      requestNumber: 'DN-2026-000012',
      programNumber: 'PN-2026-000007',
      sessionRank: '3/15',
      placeLabel: 'Maison de Cocotomey',
      serviceDate: '2026-12-04',
      total: xof(15_000),
      balance: xof(0),
      paidAt: '2026-12-04T17:30:00.000Z',
      lines: [expect.objectContaining({ kind: 'session', serviceDate: '2026-12-04' })],
      payments: [expect.objectContaining({ method: 'wallet', reference: DEBIT_ID, recordedBy: 'system' })],
    };
    expect(first.invoice).toMatchObject(expected);

    const again = await call((m) => issuance.issueInvoice(request, m));
    expect(again).toMatchObject({ created: false, invoice: { id: first.invoice!.id } });
    const reused = await call((m) => issuance.issueInvoice({ ...request, sessionRank: '4/15' }, m)).catch(
      (e: AppError) => e,
    );
    expect(reused).toMatchObject({ code: 'BILLING_IDEMPOTENCY_KEY_REUSED' });

    // « Mes factures » (contexte personnel) : la même présentation.
    const mine = await call((m) => invoices.getMyInvoice({ invoiceId: first.invoice!.id }, m));
    expect(mine.invoice).toMatchObject(expected);
  });
});
