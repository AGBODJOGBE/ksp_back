import { type paymentV1 } from '@ksp/contracts';
import { type NameBook } from '../../application/ports';
import { CURRENCY, isUnderReview, ONLINE_METHOD, type PaymentIntent } from '../../domain/payment-intent';

const iso = (value: Date | null) => (value ? value.toISOString() : '');

const NO_NAMES: NameBook = { users: new Map(), organizations: new Map() };

/**
 * Paiement → message ksp.payment.v1.Payment pour l'espace client (chaîne vide = absent) : ni noms,
 * ni détail du traitement d'un écart de montant (seulement `underReview`).
 */
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
    customerId: intent.customerId ?? '',
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
    customerName: '',
    organizationName: '',
    underReview: isUnderReview(intent),
    mismatchResolvedAt: '',
    mismatchResolvedBy: '',
    mismatchResolutionNote: '',
    paymentLinkId: intent.paymentLinkId ?? '',
  };
}

/**
 * Paiement du back-office : noms du payeur et de son organisation (ADR-029), et traitement d'un
 * écart de montant par la finance (ADR-032).
 */
export function presentAdminPayment(intent: PaymentIntent, names: NameBook = NO_NAMES): paymentV1.Payment {
  const resolution = intent.mismatchResolution;
  return {
    ...presentPayment(intent),
    customerName: (intent.customerId && names.users.get(intent.customerId)) || '',
    organizationName: (intent.organizationId && names.organizations.get(intent.organizationId)) || '',
    mismatchResolvedAt: iso(resolution?.resolvedAt ?? null),
    mismatchResolvedBy: resolution?.resolvedBy ?? '',
    mismatchResolutionNote: resolution?.note ?? '',
  };
}
