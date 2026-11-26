import { type AddressInfo, createServer } from 'node:net';
import { billingV1, commonV1 } from '@ksp/contracts';
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
import {
  CUSTOMER_ID,
  MISSION_ID,
  ORGANIZATION_ID,
  organizationContract,
  testWorld,
  type TestWorld,
} from '../src/application/testing/fakes';
import { BILLING_USE_CASES, createUseCases } from '../src/application/use-cases';
import {
  BillingAdminGrpcController,
  BillingGrpcController,
  ObligationGrpcController,
} from '../src/interfaces/grpc/billing.controller';
import { createMonthlyUseCases, MONTHLY_USE_CASES } from '../src/application/monthly/use-cases';
import { FakeWalletCredits, InMemoryMonthly } from '../src/application/testing/monthly-fakes';
import { recoveryTestWorld } from '../src/application/testing/recovery-fakes';
import {
  createRecoveryBillingUseCases,
  RECOVERY_BILLING_USE_CASES,
} from '../src/application/recovery/use-cases';

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

const CASE_ID = '0192f1c4-0000-7000-8000-0000000000ca';

describe('billing en gRPC', () => {
  let app: INestMicroservice;
  let world: TestWorld;
  let invoices: billingV1.BillingServiceClient;
  let admin: billingV1.BillingAdminServiceClient;
  let obligations: commonV1.ObligationServiceClient;
  const caller = new GrpcCaller({ target: 'billing' });

  beforeAll(async () => {
    world = testWorld();
    const useCases = createUseCases(world);
    world.contracts.add(organizationContract({ total: 150_000, durationMonths: 1 }));
    world.clock.current = new Date('2026-12-05T09:00:00Z');
    await useCases.issueDueInvoices.execute();
    // Recouvrement (ADR-064) : une facture de commission du client, encore due, et un reçu de frais.
    const recoveryWorld = recoveryTestWorld();
    const recovery = createRecoveryBillingUseCases(recoveryWorld);
    const xof = (amount: number) => ({ amount, currency: 'XOF' as const });
    await recovery.recordCollection.execute({
      eventId: '0192f1c4-0000-7000-8000-0000000000e1',
      payload: {
        caseId: CASE_ID,
        caseNumber: 'RC-000123',
        creditor: { type: 'user', id: CUSTOMER_ID },
        kind: 'b2c',
        collectionId: '0192f1c4-0000-7000-8000-0000000000c1',
        source: 'direct_to_creditor',
        gross: xof(80_000),
        allocatedCosts: xof(0),
        allocatedInterests: xof(0),
        allocatedPrincipal: xof(80_000),
        overpaid: xof(0),
        commission: xof(8_000),
        commissionSettlement: 'invoiced',
        stage: 'amicable',
        amountDueAfter: xof(0),
        receivedAt: '2026-11-10T09:00:00Z',
      },
    });
    recoveryWorld.clock.current = new Date('2026-11-30T23:00:00Z');
    await recovery.issueCommissionInvoices.execute();
    await recovery.debitCommissionInvoices.execute();
    await recovery.recordFeeReceipt.execute({
      eventId: '0192f1c4-0000-7000-8000-0000000000e2',
      payload: {
        transactionId: '0192f1c4-0000-7000-8000-0000000000d1',
        holder: { type: 'user', id: CUSTOMER_ID },
        userId: CUSTOMER_ID,
        amount: xof(15_000),
        balanceAfter: xof(0),
        service: 'recovery',
        objectType: 'recovery_case_fee',
        objectId: CASE_ID,
        part: null,
        description: 'Frais de dossier RC-000123',
        debitedAt: '2026-11-02T09:00:00Z',
      },
    });

    @Module({
      controllers: [BillingGrpcController, BillingAdminGrpcController, ObligationGrpcController],
      providers: [
        { provide: BILLING_USE_CASES, useValue: useCases },
        // Lot F : avoirs du back-office (BillingAdminService).
        {
          provide: MONTHLY_USE_CASES,
          useValue: createMonthlyUseCases({
            ...world,
            monthly: new InMemoryMonthly(world.invoices, world.recorder),
            walletCredits: new FakeWalletCredits(),
          }),
        },
        // Recouvrement (ADR-064) : factures de commission, reçus, obligations.
        { provide: RECOVERY_BILLING_USE_CASES, useValue: recovery },
        GrpcContextInterceptor,
      ],
    })
    class TestModule {}

    const port = await freePort();
    app = await NestFactory.createMicroservice<MicroserviceOptions>(TestModule, {
      ...grpcServerOptions(['billing', 'obligation'], port),
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
    obligations = (
      ClientProxyFactory.create(
        grpcClientOptions('o', 'obligation', `127.0.0.1:${port}`) as never,
      ) as unknown as ClientGrpc
    ).getService(commonV1.OBLIGATION_SERVICE_NAME);
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

  it('suppression du compte (ksp.common.v1) : la facture à payer bloque, avec sa référence', async () => {
    const response = await call(
      (m) => obligations.hasPendingObligations({ userId: CUSTOMER_ID, organizationId: '' }, m),
      { roles: [] },
    );
    expect(response).toEqual({
      hasPending: true,
      obligations: [
        {
          kind: 'unpaid_invoice',
          reference: 'FAC-2026-000001',
          description: 'La facture FAC-2026-000001 (150 000 FCFA) est en attente de paiement.',
        },
        // Recouvrement (ADR-064) : commission due, solde du portefeuille insuffisant.
        {
          kind: 'unpaid_invoice',
          reference: 'FCR-2026-000001',
          description:
            'La facture de commission FCR-2026-000001 (8 000 FCFA hors taxe) est en attente de paiement : ' +
            'elle sera débitée du portefeuille dès que son solde suffira.',
        },
      ],
    });
    await expect(
      call((m) => obligations.hasPendingObligations({ userId: 'x', organizationId: '' }, m), { roles: [] }),
    ).rejects.toMatchObject({ code: 'BILLING_VALIDATION_FAILED' });
  });

  it('paiement manuel au back-office, réglages, erreurs traduites', async () => {
    const { invoices: all } = await call(
      (m) =>
        admin.listInvoices(
          {
            status: '',
            customerId: '',
            organizationId: '',
            contractId: MISSION_ID,
            periodFrom: '',
            periodTo: '',
          },
          m,
        ),
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
            idempotencyKey: '',
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

  it('recouvrement (ADR-064) : facture de commission hors taxe et reçu de frais du client', async () => {
    const personal = { roles: ['customer'] };
    const { commissionInvoices, nextCursor } = await call(
      (m) => invoices.listMyCommissionInvoices({ status: '', period: '2026-11' }, m),
      personal,
    );
    expect(nextCursor).toBe('');
    expect(commissionInvoices).toHaveLength(1);
    expect(commissionInvoices[0]).toMatchObject({
      number: 'FCR-2026-000001',
      status: 'pending_payment',
      creditor: { type: 'user', id: CUSTOMER_ID },
      period: '2026-11',
      periodStart: '2026-10-31T23:00:00.000Z',
      totalCollected: { amount: 80_000, currency: 'XOF' },
      commissionDeducted: { amount: 0 },
      commissionInvoiced: { amount: 8_000 },
      commissionTotal: { amount: 8_000 },
      balance: { amount: 8_000 },
      amountsExcludingTax: true,
      paidAt: '',
      walletTransactionId: '',
      debit: {
        attempts: 1,
        lastFailure: 'insufficient_funds',
        missing: { amount: 8_000, currency: 'XOF' },
        nextAttemptAt: '2026-12-01T23:00:00.000Z',
      },
    });
    // Créancier sans en-tête : message absent.
    expect(commissionInvoices[0]!.organization).toBeNull();
    expect(commissionInvoices[0]!.lines).toEqual([
      {
        caseId: CASE_ID,
        caseNumber: 'RC-000123',
        collectionId: '0192f1c4-0000-7000-8000-0000000000c1',
        receivedAt: '2026-11-10T09:00:00.000Z',
        receivedOn: '2026-11-10',
        source: 'direct_to_creditor',
        gross: { amount: 80_000, currency: 'XOF' },
        commission: { amount: 8_000, currency: 'XOF' },
        settlement: 'invoiced',
      },
    ]);
    const detail = await call(
      (m) => invoices.getMyCommissionInvoice({ invoiceId: commissionInvoices[0]!.id }, m),
      personal,
    );
    expect(detail.commissionInvoice?.number).toBe('FCR-2026-000001');
    // Organisation active : pas ses factures.
    const elsewhere = await call(
      (m) => invoices.getMyCommissionInvoice({ invoiceId: commissionInvoices[0]!.id }, m),
      customer,
    ).catch((e: AppError) => e);
    expect(elsewhere).toMatchObject({ code: 'BILLING_INVOICE_NOT_FOUND' });

    const { receipts } = await call((m) => invoices.listMyFeeReceipts({ caseId: CASE_ID }, m), personal);
    expect(receipts).toEqual([
      expect.objectContaining({
        number: 'RFD-2026-000001',
        kind: 'case_fee',
        payer: { type: 'user', id: CUSTOMER_ID },
        caseNumber: 'RC-000123',
        label: 'Frais de dossier RC-000123',
        amount: { amount: 15_000, currency: 'XOF' },
        paidAt: '2026-11-02T09:00:00.000Z',
        walletTransactionId: '0192f1c4-0000-7000-8000-0000000000d1',
      }),
    ]);
  });

  it('recouvrement (ADR-064) : factures de commission au back-office, filtres et rôles', async () => {
    const recoveryAdmin = { roles: ['recovery_admin'], mfa: true };
    const { commissionInvoices } = await call(
      (m) =>
        admin.listCommissionInvoices({ status: 'pending_payment', period: '', creditorId: CUSTOMER_ID }, m),
      recoveryAdmin,
    );
    expect(commissionInvoices.map((invoice) => invoice.number)).toEqual(['FCR-2026-000001']);
    const { commissionInvoice } = await call(
      (m) => admin.getCommissionInvoice({ invoiceId: commissionInvoices[0]!.id }, m),
      finance,
    );
    expect(commissionInvoice?.debit?.lastFailure).toBe('insufficient_funds');
    const forbidden = await call(
      (m) => admin.listCommissionInvoices({ status: '', period: '', creditorId: '' }, m),
      { roles: ['cleaning_supervisor'], mfa: true },
    ).catch((e: AppError) => e);
    expect(forbidden).toMatchObject({ code: 'AUTH_FORBIDDEN' });
    const badPeriod = await call(
      (m) => admin.listCommissionInvoices({ status: '', period: '11/2026', creditorId: '' }, m),
      finance,
    ).catch((e: AppError) => e);
    expect(badPeriod).toMatchObject({ code: 'BILLING_VALIDATION_FAILED' });
  });
});
