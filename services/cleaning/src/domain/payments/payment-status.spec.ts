import {
  assertPaymentTransition,
  canTransitionPayment,
  effectivePaymentStatus,
  initialPaymentStatus,
  isPayable,
  PAYMENT_STATUSES,
  type SessionPaymentStatus,
} from './payment-status';

const at = (iso: string) => new Date(iso);

const TABLE: ReadonlyArray<[SessionPaymentStatus, SessionPaymentStatus]> = [
  ['not_due', 'due'],
  ['due', 'paid'],
  ['due', 'overdue'],
  ['overdue', 'paid'],
];

describe('transitions du paiement d’une séance (15.2)', () => {
  it.each(TABLE)('%s → %s est permise', (from, to) => {
    expect(canTransitionPayment(from, to)).toBe(true);
  });

  it('toute autre transition est refusée (CLEANING_INVALID_TRANSITION)', () => {
    const allowed = new Set(TABLE.map(([from, to]) => `${from}>${to}`));
    for (const from of PAYMENT_STATUSES) {
      for (const to of PAYMENT_STATUSES) {
        if (!allowed.has(`${from}>${to}`)) expect(canTransitionPayment(from, to)).toBe(false);
      }
    }
    expect(() => assertPaymentTransition('paid', 'due')).toThrow(
      expect.objectContaining({ code: 'CLEANING_INVALID_TRANSITION', details: { from: 'paid', to: 'due' } }),
    );
    expect(() => assertPaymentTransition('due', 'paid')).not.toThrow();
  });

  it('cas limites : rien ne mène à « dispensée », une séance payée ne repasse jamais en retard', () => {
    expect(PAYMENT_STATUSES.some((from) => canTransitionPayment(from, 'waived'))).toBe(false);
    expect(canTransitionPayment('paid', 'overdue')).toBe(false);
    expect(canTransitionPayment('not_due', 'paid')).toBe(false);
  });
});

describe('statut initial', () => {
  it('particulier : non due ; repasse gratuite : dispensée ; entreprise : aucun (facture mensuelle)', () => {
    expect(initialPaymentStatus({ payerKind: 'individual', isRedo: false })).toBe('not_due');
    expect(initialPaymentStatus({ payerKind: 'individual', isRedo: true })).toBe('waived');
    expect(initialPaymentStatus({ payerKind: 'organization', isRedo: false })).toBeNull();
  });
});

describe('statut lu d’après l’heure (R-PP-04)', () => {
  /** Séance réalisée le 23 novembre 2026 à 11 h, à payer avant le 24 à 11 h (Porto-Novo). */
  const dueBy = at('2026-11-24T11:00:00+01:00');

  it('à l’échéance pile : en retard ; une seconde avant : à payer', () => {
    expect(effectivePaymentStatus('due', dueBy, at('2026-11-24T10:59:59+01:00'))).toBe('due');
    expect(effectivePaymentStatus('due', dueBy, at('2026-11-24T11:00:00+01:00'))).toBe('overdue');
    expect(effectivePaymentStatus('due', dueBy, at('2026-11-24T10:00:00Z'))).toBe('overdue');
  });

  it('les autres statuts ne bougent pas avec l’heure', () => {
    const later = at('2026-12-31T00:00:00+01:00');
    expect(effectivePaymentStatus('paid', dueBy, later)).toBe('paid');
    expect(effectivePaymentStatus('not_due', null, later)).toBe('not_due');
    expect(effectivePaymentStatus('due', null, later)).toBe('due');
    expect(effectivePaymentStatus(null, null, later)).toBeNull();
  });

  it('payable : à payer ou en retard seulement', () => {
    expect(PAYMENT_STATUSES.filter(isPayable)).toEqual(['due', 'overdue']);
  });
});
