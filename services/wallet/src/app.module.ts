import { paymentV1 } from '@ksp/contracts';
import {
  GrpcCaller,
  grpcClientOptions,
  PlatformModule,
  SERVICE_TOKEN_PROVIDER,
  type ServiceTokenProvider,
} from '@ksp/platform';
import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { type ClientGrpc, ClientsModule } from '@nestjs/microservices';
import { createUseCases, WALLET_USE_CASES } from './application/use-cases';
import { type ServiceConfig } from './config';
import { OutboxRelayService } from './infrastructure/messaging/outbox-relay.service';
import { GrpcPayoutExecutor } from './infrastructure/payment/grpc-payout-executor';
import { GrpcTopUpPayments } from './infrastructure/payment/grpc-top-up-payments';
import { PrismaLedgerStore } from './infrastructure/persistence/prisma-ledger.store';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import { SUBMIT_INTERVAL_MS, SubmitPayoutsService } from './infrastructure/scheduling/submit-payouts.service';
import { SystemClock, UuidV7Generator } from './infrastructure/system/system';
import {
  WalletAccountGrpcController,
  WalletAdminGrpcController,
  WalletGrpcController,
} from './interfaces/grpc/wallet.controllers';
import { PayoutEventsConsumer } from './interfaces/messaging/payout-events.consumer';
import { PrepaidEventsConsumer } from './interfaces/messaging/prepaid-events.consumer';

const PAYMENT_CLIENT = Symbol('PAYMENT_CLIENT');

/** Racine de composition : relie les cas d'usage à leurs adaptateurs. */
@Module({})
export class AppModule {
  static forRoot(config: ServiceConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        PlatformModule.forRoot(config),
        ClientsModule.register([grpcClientOptions(PAYMENT_CLIENT, 'payment', config.PAYMENT_GRPC_URL)]),
      ],
      controllers: [WalletGrpcController, WalletAccountGrpcController, WalletAdminGrpcController],
      providers: [
        PrismaService,
        OutboxRelayService,
        PrismaLedgerStore,
        PayoutEventsConsumer,
        PrepaidEventsConsumer,
        SubmitPayoutsService,
        { provide: SUBMIT_INTERVAL_MS, useValue: config.WALLET_PAYOUT_SUBMIT_INTERVAL_MS },
        {
          provide: WALLET_USE_CASES,
          inject: [PrismaLedgerStore, PAYMENT_CLIENT, { token: SERVICE_TOKEN_PROVIDER, optional: true }],
          useFactory: (
            store: PrismaLedgerStore,
            payment: ClientGrpc,
            serviceTokens: ServiceTokenProvider | undefined,
          ) => {
            if (!serviceTokens) {
              new Logger('Wallet').warn(
                'Aucun jeton de service : appels vers payment non authentifiés (développement uniquement).',
              );
            }
            const caller = new GrpcCaller({
              target: 'payment',
              ...(serviceTokens ? { serviceTokenProvider: serviceTokens } : {}),
            });
            return createUseCases({
              ledger: store,
              payouts: store,
              executor: new GrpcPayoutExecutor(
                payment.getService<paymentV1.PayoutServiceClient>(paymentV1.PAYOUT_SERVICE_NAME),
                caller,
              ),
              topUps: new GrpcTopUpPayments(
                payment.getService<paymentV1.TopUpPaymentServiceClient>(
                  paymentV1.TOP_UP_PAYMENT_SERVICE_NAME,
                ),
                caller,
              ),
              settings: {
                ledgerCallers: config.WALLET_LEDGER_CALLERS,
                debitCallers: config.WALLET_DEBIT_CALLERS,
                topUpMin: config.WALLET_TOP_UP_MIN,
                topUpMax: config.WALLET_TOP_UP_MAX,
              },
              clock: new SystemClock(),
              ids: new UuidV7Generator(),
            });
          },
        },
      ],
    };
  }
}
