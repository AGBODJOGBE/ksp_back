import { identityV1, walletV1 } from '@ksp/contracts';
import { GrpcWalletLedger } from './infrastructure/wallet/grpc-wallet-ledger';
import {
  GrpcCaller,
  grpcClientOptions,
  PlatformModule,
  SERVICE_TOKEN_PROVIDER,
  type ServiceTokenProvider,
} from '@ksp/platform';
import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { type ClientGrpc, ClientsModule } from '@nestjs/microservices';
import { BILLING_USE_CASES, createUseCases } from './application/use-cases';
// Lot F : facture mensuelle des organisations, relances, avoirs.
import { createMonthlyUseCases, MONTHLY_USE_CASES } from './application/monthly/use-cases';
import { MonthlyEventsConsumer } from './infrastructure/messaging/monthly-events.consumer';
import { PrismaMonthlyInvoiceRepository } from './infrastructure/persistence/prisma-monthly-invoice.repository';
import { MonthlyBillingSchedulerService } from './infrastructure/scheduling/monthly-billing-scheduler.service';
import { PgRunLock } from './infrastructure/scheduling/pg-run-lock';
import { GrpcWalletCredits } from './infrastructure/wallet/grpc-wallet-credits';
// Recouvrement (ADR-064) : factures de commission et reçus des frais.
import { createRecoveryBillingUseCases, RECOVERY_BILLING_USE_CASES } from './application/recovery/use-cases';
import { RecoveryEventsConsumer } from './infrastructure/messaging/recovery-events.consumer';
import { PrismaRecoveryBillingRepository } from './infrastructure/persistence/prisma-recovery-billing.repository';
import { CommissionBillingSchedulerService } from './infrastructure/scheduling/commission-billing-scheduler.service';
import { type ServiceConfig } from './config';
import { IdentityOrganizationDirectory } from './infrastructure/identity/identity-organization-directory';
import { OutboxRelayService } from './infrastructure/messaging/outbox-relay.service';
import { PaymentEventsConsumer } from './infrastructure/messaging/payment-events.consumer';
import { PrismaContractRepository } from './infrastructure/persistence/prisma-contract.repository';
import { PrismaInvoiceRepository } from './infrastructure/persistence/prisma-invoice.repository';
import { PrismaSettingsRepository } from './infrastructure/persistence/prisma-settings.repository';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import {
  BILLING_SCHEDULER_INTERVAL_MS,
  BillingSchedulerService,
} from './infrastructure/scheduling/billing-scheduler.service';
import { SystemClock, UuidV7Generator } from './infrastructure/system/system';
import {
  BillingAdminGrpcController,
  BillingGrpcController,
  InvoiceIssuanceGrpcController,
  InvoicePaymentDueGrpcController,
  ObligationGrpcController,
  WalletDebitCheckGrpcController,
} from './interfaces/grpc/billing.controller';

const IDENTITY_CLIENT = Symbol('IDENTITY_CLIENT');
const WALLET_CLIENT = Symbol('WALLET_CLIENT');

/**
 * Délais croissants de nouvel essai des événements reçus, environ 1 h au total (ADR-032) : une panne
 * passagère ne fait pas partir l'événement en file d'erreurs dès la première minute.
 */
export const CONSUMER_RETRY_DELAYS_MS = [
  10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000,
];

/** Racine de composition : relie les cas d'usage à leurs adaptateurs. */
@Module({})
export class AppModule {
  static forRoot(config: ServiceConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        PlatformModule.forRoot(config, { consumerRetryDelaysMs: CONSUMER_RETRY_DELAYS_MS }),
        ClientsModule.register([
          grpcClientOptions(IDENTITY_CLIENT, 'identity', config.IDENTITY_GRPC_URL),
          grpcClientOptions(WALLET_CLIENT, 'wallet', config.WALLET_GRPC_URL),
        ]),
      ],
      controllers: [
        BillingGrpcController,
        BillingAdminGrpcController,
        InvoiceIssuanceGrpcController,
        InvoicePaymentDueGrpcController,
        ObligationGrpcController,
        WalletDebitCheckGrpcController,
      ],
      providers: [
        PrismaService,
        OutboxRelayService,
        PrismaContractRepository,
        PrismaInvoiceRepository,
        PrismaSettingsRepository,
        PaymentEventsConsumer,
        BillingSchedulerService,
        { provide: BILLING_SCHEDULER_INTERVAL_MS, useValue: config.BILLING_SCHEDULER_INTERVAL_MS },
        {
          provide: BILLING_USE_CASES,
          inject: [
            PrismaContractRepository,
            PrismaInvoiceRepository,
            PrismaSettingsRepository,
            IDENTITY_CLIENT,
            WALLET_CLIENT,
            { token: SERVICE_TOKEN_PROVIDER, optional: true },
          ],
          useFactory: (
            contracts: PrismaContractRepository,
            invoices: PrismaInvoiceRepository,
            settings: PrismaSettingsRepository,
            grpc: ClientGrpc,
            walletGrpc: ClientGrpc,
            serviceTokens: ServiceTokenProvider | undefined,
          ) => {
            if (!serviceTokens) {
              new Logger('Billing').warn(
                'Aucun jeton de service : appels vers identity et wallet non authentifiés (développement uniquement).',
              );
            }
            return createUseCases({
              contracts,
              invoices,
              settings,
              organizations: new IdentityOrganizationDirectory(
                grpc.getService<identityV1.IdentityServiceClient>(identityV1.IDENTITY_SERVICE_NAME),
                new GrpcCaller({
                  target: 'identity',
                  ...(serviceTokens ? { serviceTokenProvider: serviceTokens } : {}),
                }),
              ),
              wallet: new GrpcWalletLedger(
                walletGrpc.getService<walletV1.WalletServiceClient>(walletV1.WALLET_SERVICE_NAME),
                new GrpcCaller({
                  target: 'wallet',
                  ...(serviceTokens ? { serviceTokenProvider: serviceTokens } : {}),
                }),
              ),
              clock: new SystemClock(),
              ids: new UuidV7Generator(),
            });
          },
        },
        // Lot F : facture mensuelle des organisations (CDC Nettoyage v2, partie 11.2), mêmes
        // adaptateurs que les cas d'usage existants, plus le dépôt mensuel et wallet.Credit.
        PrismaMonthlyInvoiceRepository,
        PgRunLock,
        MonthlyEventsConsumer,
        MonthlyBillingSchedulerService,
        {
          provide: MONTHLY_USE_CASES,
          inject: [
            PrismaContractRepository,
            PrismaInvoiceRepository,
            PrismaSettingsRepository,
            PrismaMonthlyInvoiceRepository,
            IDENTITY_CLIENT,
            WALLET_CLIENT,
            { token: SERVICE_TOKEN_PROVIDER, optional: true },
          ],
          useFactory: (
            contracts: PrismaContractRepository,
            invoices: PrismaInvoiceRepository,
            settings: PrismaSettingsRepository,
            monthly: PrismaMonthlyInvoiceRepository,
            grpc: ClientGrpc,
            walletGrpc: ClientGrpc,
            serviceTokens: ServiceTokenProvider | undefined,
          ) => {
            const caller = (target: string) =>
              new GrpcCaller({ target, ...(serviceTokens ? { serviceTokenProvider: serviceTokens } : {}) });
            const wallet = walletGrpc.getService<walletV1.WalletServiceClient>(walletV1.WALLET_SERVICE_NAME);
            return createMonthlyUseCases({
              contracts,
              invoices,
              settings,
              monthly,
              organizations: new IdentityOrganizationDirectory(
                grpc.getService<identityV1.IdentityServiceClient>(identityV1.IDENTITY_SERVICE_NAME),
                caller('identity'),
              ),
              wallet: new GrpcWalletLedger(wallet, caller('wallet')),
              walletCredits: new GrpcWalletCredits(wallet, caller('wallet')),
              clock: new SystemClock(),
              ids: new UuidV7Generator(),
            });
          },
        },
        // Recouvrement (ADR-064) : encaissements et débits appris par événement, facture mensuelle de
        // commission, débit automatique (wallet.Debit), reçus ; en-tête des organisations par identity.
        PrismaRecoveryBillingRepository,
        RecoveryEventsConsumer,
        CommissionBillingSchedulerService,
        {
          provide: RECOVERY_BILLING_USE_CASES,
          inject: [
            PrismaRecoveryBillingRepository,
            IDENTITY_CLIENT,
            WALLET_CLIENT,
            { token: SERVICE_TOKEN_PROVIDER, optional: true },
          ],
          useFactory: (
            recovery: PrismaRecoveryBillingRepository,
            grpc: ClientGrpc,
            walletGrpc: ClientGrpc,
            serviceTokens: ServiceTokenProvider | undefined,
          ) => {
            const caller = (target: string) =>
              new GrpcCaller({ target, ...(serviceTokens ? { serviceTokenProvider: serviceTokens } : {}) });
            return createRecoveryBillingUseCases(
              {
                recovery,
                organizations: new IdentityOrganizationDirectory(
                  grpc.getService<identityV1.IdentityServiceClient>(identityV1.IDENTITY_SERVICE_NAME),
                  caller('identity'),
                ),
                wallet: new GrpcWalletLedger(
                  walletGrpc.getService<walletV1.WalletServiceClient>(walletV1.WALLET_SERVICE_NAME),
                  caller('wallet'),
                ),
                clock: new SystemClock(),
                ids: new UuidV7Generator(),
              },
              { debitRetryDelayMs: config.BILLING_COMMISSION_DEBIT_RETRY_MS },
            );
          },
        },
      ],
    };
  }
}
