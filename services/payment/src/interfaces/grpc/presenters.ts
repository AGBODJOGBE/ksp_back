import { type paymentV1 } from '@ksp/contracts';
import { type NameBook } from '../../application/ports';
import { CURRENCY, ONLINE_METHOD, type PaymentIntent } from '../../domain/payment-intent';

const iso = (value: Date | null) => (value ? value.toISOString() : '');

const NO_NAMES: NameBook = { users: new Map(), organizations: new Map() };

/**
 * Paiement → message ksp.payment.v1.Payment (chaîne vide = absent). Noms du payeur et de son
 * organisation : back-office seulement (ADR-029).
 */
export function presentPayment(intent: PaymentIntent, names: NameBook = NO_NAMES): paymentV1.Payment {
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
    customerName: names.users.get(intent.customerId) ?? '',
    organizationName: (intent.organizationId && names.organizations.get(intent.organizationId)) || '',
  };
}
