import {
  CreatePaymentUseCase,
  GetMyPaymentUseCase,
  ListMyPaymentsUseCase,
  ListPaymentsUseCase,
  ReceiveProviderNotificationUseCase,
  ReconcilePendingPaymentsUseCase,
  SimulatePaymentUseCase,
} from './payments.use-cases';
import { type PaymentDeps } from './ports';

/** Cas d'usage du service (une classe chacun), reliés aux mêmes dépendances. */
export function createUseCases(deps: PaymentDeps) {
  return {
    createPayment: new CreatePaymentUseCase(deps),
    getMyPayment: new GetMyPaymentUseCase(deps),
    listMyPayments: new ListMyPaymentsUseCase(deps),
    listPayments: new ListPaymentsUseCase(deps),
    receiveProviderNotification: new ReceiveProviderNotificationUseCase(deps),
    simulatePayment: new SimulatePaymentUseCase(deps),
    reconcilePendingPayments: new ReconcilePendingPaymentsUseCase(deps),
  };
}

export type PaymentUseCases = ReturnType<typeof createUseCases>;

/** Jeton d'injection des cas d'usage (racine de composition). */
export const PAYMENT_USE_CASES = Symbol('PAYMENT_USE_CASES');
