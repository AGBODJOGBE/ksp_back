import { CreateTopUpPaymentUseCase } from './top-up.use-cases';
import {
  CreatePaymentUseCase,
  GetMyPaymentUseCase,
  ListMyPaymentsUseCase,
  ListPaymentsUseCase,
  ReceiveProviderNotificationUseCase,
  ReconcilePendingPaymentsUseCase,
  ResolveAmountMismatchUseCase,
  SimulatePaymentUseCase,
} from './payments.use-cases';
import {
  CreatePaymentLinkUseCase,
  GetPaymentLinkUseCase,
  GetPublicPaymentLinkUseCase,
  PayPaymentLinkUseCase,
  RevokePaymentLinkUseCase,
  SimulatePaymentLinkPaymentUseCase,
} from './links.use-cases';
import { HasPendingObligationsUseCase } from './obligations.use-cases';
import {
  GetPayoutUseCase,
  ListPayoutsUseCase,
  ReconcilePayoutsUseCase,
  RequestPayoutUseCase,
  SettlePayoutUseCase,
} from './payouts.use-cases';
import { type PaymentDeps } from './ports';

/** Cas d'usage du service (une classe chacun), reliés aux mêmes dépendances. */
export function createUseCases(deps: PaymentDeps) {
  return {
    createTopUpPayment: new CreateTopUpPaymentUseCase(deps),
    createPayment: new CreatePaymentUseCase(deps),
    getMyPayment: new GetMyPaymentUseCase(deps),
    listMyPayments: new ListMyPaymentsUseCase(deps),
    listPayments: new ListPaymentsUseCase(deps),
    resolveAmountMismatch: new ResolveAmountMismatchUseCase(deps),
    receiveProviderNotification: new ReceiveProviderNotificationUseCase(deps),
    simulatePayment: new SimulatePaymentUseCase(deps),
    reconcilePendingPayments: new ReconcilePendingPaymentsUseCase(deps),
    hasPendingObligations: new HasPendingObligationsUseCase(deps),
    createPaymentLink: new CreatePaymentLinkUseCase(deps),
    getPaymentLink: new GetPaymentLinkUseCase(deps),
    revokePaymentLink: new RevokePaymentLinkUseCase(deps),
    getPublicPaymentLink: new GetPublicPaymentLinkUseCase(deps),
    payPaymentLink: new PayPaymentLinkUseCase(deps),
    simulatePaymentLinkPayment: new SimulatePaymentLinkPaymentUseCase(deps),
    requestPayout: new RequestPayoutUseCase(deps),
    getPayout: new GetPayoutUseCase(deps),
    listPayouts: new ListPayoutsUseCase(deps),
    confirmPayout: new SettlePayoutUseCase(deps, 'completed'),
    failPayout: new SettlePayoutUseCase(deps, 'failed'),
    reconcilePayouts: new ReconcilePayoutsUseCase(deps),
  };
}

export type PaymentUseCases = ReturnType<typeof createUseCases>;

/** Jeton d'injection des cas d'usage (racine de composition). */
export const PAYMENT_USE_CASES = Symbol('PAYMENT_USE_CASES');
