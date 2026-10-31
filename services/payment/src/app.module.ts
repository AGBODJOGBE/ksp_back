import { billingV1, cleaningV1 } from '@ksp/contracts';
import {
  GrpcCaller,
  grpcClientOptions,
  PlatformModule,
  SERVICE_TOKEN_PROVIDER,
  type ServiceTokenProvider,
} from '@ksp/platform';
import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { type ClientGrpc, ClientsModule } from '@nestjs/microservices';
import { type PaymentProvider } from './application/ports';
import { createUseCases, PAYMENT_USE_CASES } from './application/use-cases';
import { type ServiceConfig, simulationEnabled } from './config';
import { LoggerPaymentAlerts } from './infrastructure/alerts/logger-payment-alerts';
import { GrpcAmountDueDirectory } from './infrastructure/dues/grpc-amount-due.directory';
import { OutboxRelayService } from './infrastructure/messaging/outbox-relay.service';
import {
  PrismaPaymentRepository,
  PrismaProviderNotificationLog,
} from './infrastructure/persistence/prisma-payment.repository';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import { FEDAPAY_API_URLS, FedapayProvider } from './infrastructure/providers/fedapay.provider';
import { SimulatedProvider } from './infrastructure/providers/simulated.provider';
import {
  RECONCILE_INTERVAL_MS,
  ReconcilePaymentsService,
} from './infrastructure/scheduling/reconcile-payments.service';
import { SystemClock, UuidV7Generator } from './infrastructure/system/system';
import {
  PaymentAdminGrpcController,
  PaymentGrpcController,
  PaymentWebhookGrpcController,
} from './interfaces/grpc/payment.controllers';

const CLEANING_CLIENT = Symbol('CLEANING_CLIENT');
const BILLING_CLIENT = Symbol('BILLING_CLIENT');

/** Prestataire choisi par la configuration (ADR-031) : FedaPay, ou simulé en développement. */
export function createProvider(config: ServiceConfig): PaymentProvider {
  if (config.PAYMENT_PROVIDER === 'fedapay') {
    return new FedapayProvider({
      apiUrl: (config.FEDAPAY_API_URL ?? FEDAPAY_API_URLS[config.FEDAPAY_ENVIRONMENT]).replace(/\/+$/, ''),
      secretKey: config.FEDAPAY_SECRET_KEY ?? '',
      webhookSecret: config.FEDAPAY_WEBHOOK_SECRET ?? '',
      xofCurrencyId: config.FEDAPAY_XOF_CURRENCY_ID,
    });
  }
  return new SimulatedProvider(config.PAYMENT_SIMULATION_CHECKOUT_URL);
}

/** Racine de composition : relie les cas d'usage à leurs adaptateurs. */
@Module({})
export class AppModule {
  static forRoot(config: ServiceConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        PlatformModule.forRoot(config),
        ClientsModule.register([
          grpcClientOptions(CLEANING_CLIENT, 'cleaning', config.CLEANING_GRPC_URL),
          grpcClientOptions(BILLING_CLIENT, 'billing', config.BILLING_GRPC_URL),
        ]),
      ],
      controllers: [PaymentGrpcController, PaymentWebhookGrpcController, PaymentAdminGrpcController],
      providers: [
        PrismaService,
        OutboxRelayService,
        PrismaPaymentRepository,
        PrismaProviderNotificationLog,
        ReconcilePaymentsService,
        { provide: RECONCILE_INTERVAL_MS, useValue: config.PAYMENT_RECONCILE_INTERVAL_MS },
        {
          provide: PAYMENT_USE_CASES,
          inject: [
            PrismaPaymentRepository,
            PrismaProviderNotificationLog,
            CLEANING_CLIENT,
            BILLING_CLIENT,
            { token: SERVICE_TOKEN_PROVIDER, optional: true },
          ],
          useFactory: (
            payments: PrismaPaymentRepository,
            notifications: PrismaProviderNotificationLog,
            cleaning: ClientGrpc,
            billing: ClientGrpc,
            serviceTokens: ServiceTokenProvider | undefined,
          ) => {
            const logger = new Logger('Payment');
            if (!serviceTokens) {
              logger.warn(
                'Aucun jeton de service : appels vers cleaning et billing non authentifiés (développement uniquement).',
              );
            }
            const caller = (target: string) =>
              new GrpcCaller({ target, ...(serviceTokens ? { serviceTokenProvider: serviceTokens } : {}) });
            const provider = createProvider(config);
            logger.log(`Prestataire de paiement : ${provider.name}`);
            return createUseCases({
              payments,
              notifications,
              dues: new GrpcAmountDueDirectory(
                {
                  client: cleaning.getService<cleaningV1.MissionPaymentDueServiceClient>(
                    cleaningV1.MISSION_PAYMENT_DUE_SERVICE_NAME,
                  ),
                  caller: caller('cleaning'),
                },
                {
                  client: billing.getService<billingV1.InvoicePaymentDueServiceClient>(
                    billingV1.INVOICE_PAYMENT_DUE_SERVICE_NAME,
                  ),
                  caller: caller('billing'),
                },
              ),
              provider,
              alerts: new LoggerPaymentAlerts(),
              settings: {
                intentTtlMinutes: config.PAYMENT_INTENT_TTL_MINUTES,
                returnUrl: config.PAYMENT_RETURN_URL,
                recheckAfterSeconds: config.PAYMENT_RECHECK_AFTER_SECONDS,
                simulationEnabled: simulationEnabled(config),
                lateSuccessWindowHours: config.PAYMENT_LATE_SUCCESS_WINDOW_HOURS,
                lateSuccessRecheckMinutes: config.PAYMENT_LATE_SUCCESS_RECHECK_MINUTES,
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
