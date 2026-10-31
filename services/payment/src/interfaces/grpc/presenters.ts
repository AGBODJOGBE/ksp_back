import { type paymentV1 } from '@ksp/contracts';
import { CURRENCY, ONLINE_METHOD, type PaymentIntent } from '../../domain/payment-intent';

const iso = (value: Date | null) => (value ? value.toISOString() : '');

/** Paiement → message ksp.payment.v1.Payment (chaîne vide = absent). */
export function presentPayment(intent: PaymentIntent): paymentV1.Payment {
  return {
    id: intent.id,
    status: intent.status,
    subject: {
      type: intent.subject.type,
      id: intent.subject.id,
      part: intent.subject.part ?? '',
      reference: intent.subject.reference ?? '',
    },
    amount: { amount: intent.amount, currency: CURRENCY },
    customerId: intent.customerId,
    organizationId: intent.organizationId ?? '',
    method: ONLINE_METHOD,
    provider: intent.provider,
    providerReference: intent.providerReference ?? '',
    checkoutUrl: intent.status === 'pending' ? (intent.checkoutUrl ?? '') : '',
    failureReason: intent.failureReason ?? '',
    createdAt: iso(intent.createdAt),
    updatedAt: iso(intent.updatedAt),
    expiresAt: iso(intent.expiresAt),
    completedAt: iso(intent.completedAt),
  };
}
