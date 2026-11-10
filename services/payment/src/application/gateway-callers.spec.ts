import { type AppError, runWithContext } from '@ksp/platform';
import { makeDeps, MISSION_ID, STAFF_ID } from './testing/fakes';
import { createUseCases, type PaymentUseCases } from './use-cases';

/**
 * Méthodes « utilisateur » et back-office : seule la gateway les appelle (ADR-048). Un autre service
 * qui transmettrait un utilisateur dans ses métadonnées est refusé, avant toute lecture.
 */
const UUID = '0192f1c4-0000-7000-8000-00000000ffff';
const CALLS: [string, (u: PaymentUseCases) => Promise<unknown>][] = [
  [
    'createPayment',
    (u) =>
      u.createPayment.execute({
        subjectType: 'cleaning_mission',
        subjectId: MISSION_ID,
        part: 'deposit',
        idempotencyKey: 'pay-key-0001',
      }),
  ],
  ['getMyPayment', (u) => u.getMyPayment.execute(UUID)],
  ['listMyPayments', (u) => u.listMyPayments.execute({ page: { limit: 20, cursor: null }, status: '' })],
  [
    'listPayments',
    (u) =>
      u.listPayments.execute({
        page: { limit: 20, cursor: null },
        status: '',
        subjectType: '',
        subjectId: '',
        customerId: '',
        organizationId: '',
      }),
  ],
  [
    'resolveAmountMismatch',
    (u) => u.resolveAmountMismatch.execute({ paymentId: UUID, note: 'remboursé', idempotencyKey: '' }),
  ],
  ['simulatePayment', (u) => u.simulatePayment.execute({ paymentId: UUID, outcome: 'succeeded' })],
  ['getPublicPaymentLink', (u) => u.getPublicPaymentLink.execute('x'.repeat(43))],
  [
    'payPaymentLink',
    (u) => u.payPaymentLink.execute({ token: 'x'.repeat(43), idempotencyKey: 'k-12345678' }),
  ],
  [
    'simulatePaymentLinkPayment',
    (u) => u.simulatePaymentLinkPayment.execute({ token: 'x'.repeat(43), outcome: 'succeeded' }),
  ],
  [
    'listPayouts',
    (u) => u.listPayouts.execute({ page: { limit: 20, cursor: null }, status: '', issuer: '' }),
  ],
  ['confirmPayout', (u) => u.confirmPayout.execute({ payoutId: UUID, text: 'REF-1', idempotencyKey: '' })],
  ['failPayout', (u) => u.failPayout.execute({ payoutId: UUID, text: 'refusé', idempotencyKey: '' })],
];

describe('méthodes réservées à la gateway', () => {
  const useCases = createUseCases(makeDeps());

  it.each(CALLS)('%s : un autre service est refusé', async (_name, call) => {
    let error: AppError | undefined;
    try {
      await runWithContext(
        {
          correlationId: 'c-test',
          callerService: 'cleaning',
          user: {
            userId: STAFF_ID,
            sessionId: 's-test',
            activeContext: 'personal',
            roles: [
              { role: 'finance_officer', scopeType: 'global' },
              { role: 'customer', scopeType: 'global' },
            ],
            mfa: true,
            authTime: Math.floor(Date.now() / 1000),
          },
        },
        () => call(useCases),
      );
    } catch (caught) {
      error = caught as AppError;
    }
    expect(error?.code).toBe('PAYMENT_CALLER_FORBIDDEN');
  });
});
