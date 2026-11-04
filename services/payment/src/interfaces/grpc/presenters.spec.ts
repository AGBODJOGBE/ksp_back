import { type PaymentIntent } from '../../domain/payment-intent';
import { presentAdminPayment, presentPayment } from './presenters';

const intent = (overrides: Partial<PaymentIntent> = {}): PaymentIntent => ({
  id: 'p1',
  subject: { type: 'billing_invoice', id: 'i1', part: null, reference: 'FAC-2026-000001' },
  amount: 10000,
  customerId: 'u1',
  organizationId: 'o1',
  status: 'pending',
  provider: 'fedapay',
  providerTransactionId: null,
  providerReference: null,
  checkoutUrl: null,
  idempotencyKey: 'pay-key-0001',
  failureReason: null,
  createdAt: new Date('2026-11-02T09:00:00.000Z'),
  updatedAt: new Date('2026-11-02T09:00:00.000Z'),
  expiresAt: new Date('2026-11-02T09:30:00.000Z'),
  completedAt: null,
  lastCheckedAt: null,
  mismatchResolution: null,
  version: 0,
  ...overrides,
});

describe('présentation d’un paiement', () => {
  it('back-office : noms du payeur et de son organisation ; vides s’ils sont inconnus', () => {
    const names = {
      users: new Map([['u1', 'Koffi Adjovi']]),
      organizations: new Map([['o1', 'SARL Bénin Propre']]),
    };
    expect(presentAdminPayment(intent(), names)).toMatchObject({
      customerName: 'Koffi Adjovi',
      organizationName: 'SARL Bénin Propre',
    });
    expect(presentAdminPayment(intent({ customerId: 'u2', organizationId: null }), names)).toMatchObject({
      customerName: '',
      organizationName: '',
    });
  });

  it('espace client : aucun nom', () => {
    expect(presentPayment(intent())).toMatchObject({ customerName: '', organizationName: '' });
  });

  const resolved = {
    resolvedAt: new Date('2026-11-05T10:00:00.000Z'),
    resolvedBy: 's1',
    note: 'Remboursé au client le 05/11.',
    idempotencyKey: null,
  };

  it('écart de montant : underReview tant qu’il n’est pas traité, pour tout autre statut false', () => {
    expect(presentPayment(intent({ status: 'amount_mismatch' })).underReview).toBe(true);
    expect(presentPayment(intent({ status: 'succeeded' })).underReview).toBe(false);
    expect(
      presentPayment(intent({ status: 'amount_mismatch', mismatchResolution: resolved })).underReview,
    ).toBe(false);
  });

  it('traitement de l’écart : détail au back-office seulement, jamais la note côté client', () => {
    const treated = intent({ status: 'amount_mismatch', mismatchResolution: resolved });
    expect(presentAdminPayment(treated)).toMatchObject({
      underReview: false,
      mismatchResolvedAt: '2026-11-05T10:00:00.000Z',
      mismatchResolvedBy: 's1',
      mismatchResolutionNote: 'Remboursé au client le 05/11.',
    });
    expect(presentPayment(treated)).toMatchObject({
      mismatchResolvedAt: '',
      mismatchResolvedBy: '',
      mismatchResolutionNote: '',
    });
  });
});
