import { debitDecision } from './debit';
import { directPaymentExpiry, paySession, sessionPayability, settleDirectPayment } from './direct-payment';

const at = (iso: string) => new Date(iso);
const NOW = at('2026-11-23T12:00:00+01:00');
const DUE_BY = at('2026-11-24T11:00:00+01:00');
const PROVIDER_EXPIRY = at('2026-11-24T12:00:00+01:00');
const pay = (overrides: Partial<Parameters<typeof paySession>[0]> = {}) =>
  paySession({
    payerKind: 'individual',
    paymentStatus: 'due',
    dueBy: DUE_BY,
    netAmount: 10_000,
    balance: 3_000,
    method: 'mobile_money',
    directPayments: [],
    providerExpiry: PROVIDER_EXPIRY,
    now: NOW,
    ...overrides,
  });

describe('payer une séance (PaySession, R-WL-05, RV-95)', () => {
  it('solde 3 000, dû 10 000 : page Mobile Money de 7 000 ; à la réception, débit de 10 000', () => {
    expect(pay()).toEqual({ kind: 'new_page', amount: 7_000, expiresAt: DUE_BY });
    const credited = 3_000 + 7_000;
    const session = {
      id: 's-3',
      rank: 3,
      sessionsCount: 15,
      paymentStatus: 'due' as const,
      dueBy: DUE_BY,
      netAmount: 10_000,
      attempt: 1,
    };
    expect(debitDecision(session, credited, NOW)).toMatchObject({ action: 'debit', amount: 10_000 });
  });

  it('solde suffisant : débit du wallet, sans page, quel que soit le moyen choisi', () => {
    expect(pay({ balance: 10_000 })).toEqual({ kind: 'debit_wallet' });
    expect(pay({ balance: 10_000, method: 'wallet' })).toEqual({ kind: 'debit_wallet' });
  });

  it('wallet demandé, solde insuffisant : CLEANING_INSUFFICIENT_BALANCE avec ce qui manque', () => {
    expect(() => pay({ method: 'wallet', balance: 9_999 })).toThrow(
      expect.objectContaining({ code: 'CLEANING_INSUFFICIENT_BALANCE', details: { missing: 1 } }),
    );
  });

  it('entreprise : CLEANING_PAYMENT_VIA_INVOICE ; rien à payer : CLEANING_NOTHING_TO_PAY', () => {
    expect(() => pay({ payerKind: 'organization', paymentStatus: null })).toThrow(
      expect.objectContaining({ code: 'CLEANING_PAYMENT_VIA_INVOICE' }),
    );
    expect(() => pay({ paymentStatus: 'paid' })).toThrow(
      expect.objectContaining({ code: 'CLEANING_NOTHING_TO_PAY' }),
    );
  });
});

describe('un seul paiement direct en cours par objet (RV-90)', () => {
  const pending = {
    id: 'dp-1',
    status: 'pending' as const,
    amount: 7_000,
    checkoutUrl: 'https://pay.example/dp-1',
    expiresAt: DUE_BY,
    debited: false,
  };

  it('page en cours : renvoyée telle quelle', () => {
    expect(pay({ directPayments: [pending] })).toEqual({ kind: 'existing_page', payment: pending });
  });

  it('page expirée à l’instant même : une nouvelle page est créée', () => {
    expect(pay({ directPayments: [pending], now: DUE_BY, paymentStatus: 'overdue' })).toMatchObject({
      kind: 'new_page',
    });
  });

  it('paiement réussi pas encore débité : awaiting_payment, sans nouvelle page', () => {
    expect(pay({ directPayments: [{ ...pending, status: 'succeeded' }] })).toEqual({
      kind: 'awaiting_payment',
    });
    expect(pay({ directPayments: [{ ...pending, status: 'succeeded', debited: true }] })).toMatchObject({
      kind: 'new_page',
    });
  });
});

describe('échéance d’une page de paiement (R-PP-07)', () => {
  it('au plus tard l’échéance de l’objet ; échéance passée (séance en retard) : celle du prestataire', () => {
    expect(directPaymentExpiry(PROVIDER_EXPIRY, DUE_BY, NOW)).toEqual(DUE_BY);
    expect(directPaymentExpiry(at('2026-11-23T13:00:00+01:00'), DUE_BY, NOW)).toEqual(
      at('2026-11-23T13:00:00+01:00'),
    );
    expect(directPaymentExpiry(PROVIDER_EXPIRY, DUE_BY, DUE_BY)).toEqual(PROVIDER_EXPIRY);
    expect(directPaymentExpiry(PROVIDER_EXPIRY, null, NOW)).toEqual(PROVIDER_EXPIRY);
  });
});

describe('paiement reçu pour un objet qui n’est plus payable (R-PP-07, RV-89)', () => {
  it('séance à payer ou en retard : le débit suit le crédit', () => {
    expect(settleDirectPayment(sessionPayability('due'))).toEqual({ outcome: 'debit' });
    expect(settleDirectPayment(sessionPayability('overdue'))).toEqual({ outcome: 'debit' });
  });

  it('déjà payée, dispensée ou annulée : rien n’est débité, le montant reste au wallet', () => {
    expect(settleDirectPayment(sessionPayability('paid'))).toEqual({
      outcome: 'left_in_wallet',
      cause: 'already_paid',
    });
    expect(settleDirectPayment(sessionPayability('waived'))).toEqual({
      outcome: 'left_in_wallet',
      cause: 'waived',
    });
    expect(settleDirectPayment(sessionPayability('not_due'))).toEqual({
      outcome: 'left_in_wallet',
      cause: 'cancelled',
    });
  });

  it('demande close (frais de visite) : même circuit', () => {
    expect(settleDirectPayment({ payable: false, cause: 'request_closed' })).toEqual({
      outcome: 'left_in_wallet',
      cause: 'request_closed',
    });
  });
});
