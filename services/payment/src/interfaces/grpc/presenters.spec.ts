import { type PaymentIntent } from '../../domain/payment-intent';
import { presentPayment } from './presenters';

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
  version: 0,
  ...overrides,
});

describe('présentation d’un paiement', () => {
  it('back-office : noms du payeur et de son organisation ; vides s’ils sont inconnus', () => {
    const names = {
      users: new Map([['u1', 'Koffi Adjovi']]),
      organizations: new Map([['o1', 'SARL Bénin Propre']]),
    };
    expect(presentPayment(intent(), names)).toMatchObject({
      customerName: 'Koffi Adjovi',
      organizationName: 'SARL Bénin Propre',
    });
    expect(presentPayment(intent({ customerId: 'u2', organizationId: null }), names)).toMatchObject({
      customerName: '',
      organizationName: '',
    });
  });

  it('espace client : aucun nom', () => {
    expect(presentPayment(intent())).toMatchObject({ customerName: '', organizationName: '' });
  });
});
