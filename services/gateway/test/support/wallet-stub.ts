import { walletV1 } from '@ksp/contracts';
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
import { freePort, type TestKeys } from './harness';

/**
 * Service wallet simulé pour les tests de la gateway : implémente WalletAccountService et
 * WalletAdminService générés depuis wallet.proto, vérifie le jeton de service comme le vrai service.
 */
export const HOLDER_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0a01';
const xof = (amount: number) => ({ amount, currency: 'XOF' });

export const protoWallet: walletV1.Wallet = {
  holder: { type: 'organization', id: HOLDER_ID },
  balance: xof(8750),
  payoutsInProgress: xof(21875),
  totalCollected: xof(30625),
  totalPaidOut: xof(0),
  lastEntryAt: '2026-11-07T10:05:00.000Z',
  prepaid: {
    holder: { type: 'organization', id: HOLDER_ID },
    balance: xof(5000),
    lastEntryAt: '2026-11-08T09:00:00.000Z',
  },
};

/** Paiement de l'acompte d'une mission depuis le portefeuille prépayé (ADR-046). */
export const protoPrepaidLine: walletV1.StatementLine = {
  transactionId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d7010',
  kind: 'service_payment',
  direction: 'debit',
  amount: xof(15000),
  balanceAfter: xof(5000),
  reference: 'debit:0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d1000:deposit:cle-0001',
  description: 'Nettoyage de maison — acompte',
  grossAmount: undefined,
  commission: undefined,
  commissionRateBps: 0,
  payoutId: '',
  payoutStatus: '',
  reversesTransactionId: '',
  createdAt: '2026-11-08T09:00:00.000Z',
  account: 'prepaid',
  object: {
    service: 'cleaning',
    objectType: 'cleaning_mission',
    objectId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d1000',
    part: 'deposit',
  },
};

export const protoStatement: walletV1.StatementPage = {
  lines: [
    {
      transactionId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d7002',
      kind: 'payout',
      direction: 'debit',
      amount: xof(21875),
      balanceAfter: xof(8750),
      reference: 'payout:0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d7001',
      description: 'Reversement Mobile Money',
      grossAmount: undefined,
      commission: undefined,
      commissionRateBps: 0,
      payoutId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d7001',
      payoutStatus: 'submitted',
      reversesTransactionId: '',
      createdAt: '2026-11-07T10:05:00.000Z',
      account: 'collections',
      object: undefined,
    },
    {
      transactionId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d7000',
      kind: 'collection',
      direction: 'credit',
      amount: xof(21875),
      balanceAfter: xof(30625),
      reference: 'payment:0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d5002',
      description: 'Échéance 2 sur 6',
      grossAmount: xof(25000),
      commission: xof(3125),
      commissionRateBps: 1250,
      payoutId: '',
      payoutStatus: '',
      reversesTransactionId: '',
      createdAt: '2026-11-07T10:00:00.000Z',
      account: 'collections',
      object: undefined,
    },
  ],
  nextCursor: '',
};

export const protoWalletPayout: walletV1.WalletPayout = {
  id: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d7001',
  holder: { type: 'organization', id: HOLDER_ID },
  amount: xof(21875),
  status: 'submitted',
  paymentPayoutId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d6001',
  beneficiaryOperator: 'mtn',
  beneficiaryPhoneMasked: '+229 •• •• 45',
  holdTransactionId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d7002',
  settlementTransactionId: '',
  createdAt: '2026-11-07T10:05:00.000Z',
  updatedAt: '2026-11-07T10:05:01.000Z',
  completedAt: '',
  failedAt: '',
};

type Method = keyof walletV1.WalletAccountServiceController | keyof walletV1.WalletAdminServiceController;
const ACCOUNT_METHODS: readonly Method[] = ['getMyWallet', 'listMyStatement', 'listMyPayouts', 'createTopUp'];

const DEFAULTS: Record<Method, () => unknown> = {
  getMyWallet: () => ({ wallet: protoWallet, topUpLimits: { min: xof(500), max: xof(1000000) } }),
  listMyStatement: () => ({ statement: protoStatement }),
  createTopUp: () => ({
    topUp: {
      paymentId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d5009',
      holder: { type: 'organization', id: HOLDER_ID },
      amount: xof(20000),
      status: 'pending',
      checkoutUrl: 'https://process.fedapay.com/tok9',
      expiresAt: '2026-11-08T09:30:00.000Z',
    },
    created: true,
  }),
  creditPrepaidWallet: () => ({
    transaction: {
      id: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d7011',
      kind: 'refund',
      reference: 'credit:cle-0192f1c4-0001',
      holder: { type: 'organization', id: HOLDER_ID },
      amount: xof(5000),
      grossAmount: undefined,
      commission: undefined,
      commissionRateBps: 0,
      description: 'Passage du 3 novembre non effectué',
      reversesTransactionId: '',
      createdAt: '2026-11-08T10:00:00.000Z',
      entries: [],
      object: undefined,
    },
    wallet: {
      holder: { type: 'organization', id: HOLDER_ID },
      balance: xof(10000),
      lastEntryAt: '2026-11-08T10:00:00.000Z',
    },
    created: true,
  }),
  listMyPayouts: () => ({ payouts: [protoWalletPayout], nextCursor: '' }),
  getHolderWallet: () => ({ wallet: protoWallet }),
  listHolderStatement: () => ({ statement: protoStatement }),
  listWalletPayouts: () => ({ payouts: [protoWalletPayout], nextCursor: protoWalletPayout.id }),
  getLedgerOverview: () => ({
    internalAccounts: [
      { account: 'ksp:collections', balance: xof(33750) },
      { account: 'ksp:commission', balance: xof(3125) },
      { account: 'ksp:payouts_in_transit', balance: xof(21875) },
    ],
    owedToHolders: xof(8750),
    holdersCount: 1,
    owedToCustomers: xof(5000),
    customersCount: 1,
  }),
};

export class WalletStub {
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

const STUB = Symbol('WALLET_STUB');

function stubController(methods: readonly Method[], decorate: () => ClassDecorator) {
  @Controller()
  class StubController {
    constructor(@Inject(STUB) readonly stub: WalletStub) {}
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

export interface WalletServer {
  stub: WalletStub;
  url: string;
  close(): Promise<void>;
}

export async function startWalletStub(keys: TestKeys): Promise<WalletServer> {
  const stub = new WalletStub();
  const all = Object.keys(DEFAULTS) as Method[];

  @Module({
    controllers: [
      stubController(ACCOUNT_METHODS, walletV1.WalletAccountServiceControllerMethods),
      stubController(
        all.filter((method) => !ACCOUNT_METHODS.includes(method)),
        walletV1.WalletAdminServiceControllerMethods,
      ),
    ],
    providers: [{ provide: STUB, useValue: stub }],
  })
  class StubModule {}

  const port = await freePort();
  const app: INestMicroservice = await NestFactory.createMicroservice<MicroserviceOptions>(StubModule, {
    ...grpcServerOptions(['wallet'], port),
    logger: false,
  });
  app.useGlobalFilters(new GrpcExceptionFilter());
  app.useGlobalInterceptors(
    new GrpcContextInterceptor(
      new ServiceTokenVerifier({
        audience: 'wallet',
        issuer: 'ksp-identity',
        keys: createLocalJWKSet(keys.serviceJwks),
      }),
    ),
  );
  await app.listen();
  return { stub, url: `127.0.0.1:${port}`, close: () => app.close() };
}
