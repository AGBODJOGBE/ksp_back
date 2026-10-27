import { type AddressInfo, createServer } from 'node:net';
import { billingV1 } from '@ksp/contracts';
import {
  AppError,
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
import { CUSTOMER_ID, ORGANIZATION_ID, testWorld, type TestWorld } from '../src/application/testing/fakes';
import { BILLING_USE_CASES, createUseCases } from '../src/application/use-cases';
import { BillingAdminGrpcController, BillingGrpcController } from '../src/interfaces/grpc/billing.controller';

/**
 * Bout en bout sur un vrai serveur gRPC (doublures en mémoire, sans base) : chargement du
 * paquet billing, traduction des messages, contexte utilisateur dans les métadonnées comme le
 * fait la gateway, et traduction des erreurs.
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

const MISSION_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d1000';

describe('billing en gRPC', () => {
  let app: INestMicroservice;
  let world: TestWorld;
  let invoices: billingV1.BillingServiceClient;
  let admin: billingV1.BillingAdminServiceClient;
  const caller = new GrpcCaller({ target: 'billing' });

  beforeAll(async () => {
    world = testWorld();
    const useCases = createUseCases(world);
    await useCases.registerContract.execute({
      eventId: '0192f1c4-7a2b-7c3d-8e4f-000000009001',
      type: 'cleaning.booking.confirmed',
      occurredAt: '2026-10-23T08:00:00Z',
      payload: {
        requestId: '0192f1c4-7a2b-7c3d-8e4f-000000009050',
        quoteId: '0192f1c4-7a2b-7c3d-8e4f-000000009051',
        missionId: MISSION_ID,
        customerId: CUSTOMER_ID,
        organizationId: ORGANIZATION_ID,
        total: { amount: 150_000, currency: 'XOF' },
        plannedInterventions: 4,
        recurrence: { period: 'week', visitsPerPeriod: 1, durationMonths: 1 },
        paymentPlan: { option: 'full', timing: 'after', method: 'cash' },
        depositAmount: { amount: 150_000, currency: 'XOF' },
        startsAt: '2026-10-31T23:00:00.000Z',
      },
    });
    world.clock.current = new Date('2026-12-05T09:00:00Z');
    await useCases.issueDueInvoices.execute();

    @Module({
      controllers: [BillingGrpcController, BillingAdminGrpcController],
      providers: [{ provide: BILLING_USE_CASES, useValue: useCases }, GrpcContextInterceptor],
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
    invoices = client.getService(billingV1.BILLING_SERVICE_NAME);
    admin = client.getService(billingV1.BILLING_ADMIN_SERVICE_NAME);
  });

  afterAll(async () => {
    await app?.close();
  });

  const call = <T>(
    invoke: (metadata: Metadata) => Observable<T>,
    user: { roles: string[]; mfa?: boolean; activeContext?: string },
  ): Promise<T> =>
    runWithContext(
      {
        correlationId: '0192f1c4-0000-7000-8000-00000000c0de',
        user: {
          userId: CUSTOMER_ID,
          sessionId: 's',
          activeContext: user.activeContext ?? 'personal',
          roles: user.roles.map((role) => ({ role, scopeType: 'global' as const })),
          mfa: user.mfa ?? false,
          authTime: Math.floor(Date.now() / 1000),
        },
      },
      () => caller.call('test', invoke),
    );
  const customer = { roles: ['customer'], activeContext: ORGANIZATION_ID };
  const finance = { roles: ['finance_officer'], mfa: true };

  it('« Mes factures » : montants entiers XOF, échéance, solde', async () => {
    const { invoices: mine } = await call((m) => invoices.listMyInvoices({ status: '' }, m), customer);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      number: 'FAC-2026-000001',
      status: 'pending_payment',
      organizationId: ORGANIZATION_ID,
      total: { amount: 150_000, currency: 'XOF' },
      balance: { amount: 150_000, currency: 'XOF' },
      dueAt: '2026-12-15T09:00:00.000Z',
      paidAt: '',
    });
    const detail = await call((m) => invoices.getMyInvoice({ invoiceId: mine[0]!.id }, m), customer);
    expect(detail.invoice?.lines[0]).toMatchObject({ quantity: 1, amount: { amount: 150_000 } });
    expect(detail.invoice?.organization).toEqual({
      legalName: 'SARL Bénin Propre',
      address: 'Lot 12, Haie Vive, Cotonou',
      ifu: '3201912345678',
      rccm: 'RB/COT/19 B 1234',
    });
  });

  it('paiement manuel au back-office, réglages, erreurs traduites', async () => {
    const { invoices: all } = await call(
      (m) =>
        admin.listInvoices({ status: '', customerId: '', organizationId: '', contractId: MISSION_ID }, m),
      finance,
    );
    const { invoice } = await call(
      (m) =>
        admin.recordInvoicePayment(
          {
            invoiceId: all[0]!.id,
            amount: { amount: 150_000, currency: 'XOF' },
            method: 'cash',
            reference: 'reçu 7',
          },
          m,
        ),
      finance,
    );
    expect(invoice).toMatchObject({
      status: 'paid',
      balance: { amount: 0 },
      paidAt: '2026-12-05T09:00:00.000Z',
    });
    const { settings } = await call((m) => admin.getBillingSettings({}, m), finance);
    expect(settings).toMatchObject({ paymentTermDays: 10 });
    const failure = await call((m) => admin.getBillingSettings({}, m), customer).catch((e: AppError) => e);
    expect(failure).toMatchObject({ code: 'AUTH_FORBIDDEN' });
  });
});
