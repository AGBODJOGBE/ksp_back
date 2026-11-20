import { countOverdue, debitDecision, markOverdue, nextDebitAttempt, recordDebitSucceeded } from './debit';

const at = (iso: string) => new Date(iso);
const DUE_BY = at('2026-11-24T11:00:00+01:00');
const session = (overrides: Partial<Parameters<typeof debitDecision>[0]> = {}) => ({
  id: 's-3',
  rank: 3,
  sessionsCount: 15,
  paymentStatus: 'due' as const,
  dueBy: DUE_BY,
  netAmount: 15_000,
  attempt: 1,
  ...overrides,
});

describe('débit automatique du wallet (R-PP-01, R-PP-03)', () => {
  const NOW = at('2026-11-23T11:00:00+01:00');

  it('solde égal au montant : débit avec la clé de la séance et son objet', () => {
    expect(debitDecision(session(), 15_000, NOW)).toEqual({
      action: 'debit',
      idempotencyKey: 'cleaning_session:s-3',
      amount: 15_000,
      label: 'Nettoyage — séance 3/15',
    });
  });

  it('un franc de moins : la séance attend son paiement, il manque 1 FCFA', () => {
    expect(debitDecision(session(), 14_999, NOW)).toEqual({ action: 'await', missing: 1, status: 'due' });
  });

  it('séance en retard d’après l’heure : l’attente le dit', () => {
    expect(debitDecision(session(), 0, DUE_BY)).toEqual({
      action: 'await',
      missing: 15_000,
      status: 'overdue',
    });
  });

  it('nouvelle tentative après un débit remboursé : clé numérotée', () => {
    expect(nextDebitAttempt(1)).toBe(2);
    expect(debitDecision(session({ attempt: 2 }), 20_000, NOW)).toMatchObject({
      idempotencyKey: 'cleaning_session:s-3:2',
    });
  });

  it('séance payée, dispensée, non due, ou d’entreprise : rien à débiter', () => {
    for (const paymentStatus of ['paid', 'waived', 'not_due', null] as const) {
      expect(debitDecision(session({ paymentStatus }), 99_999, NOW)).toEqual({ action: 'none' });
    }
  });
});

describe('retard et paiement (R-PP-04)', () => {
  it('à l’échéance pile, la séance à payer passe « en retard » ; une seconde avant, non', () => {
    expect(markOverdue({ paymentStatus: 'due', dueBy: DUE_BY }, at('2026-11-24T10:59:59+01:00'))).toBe('due');
    expect(markOverdue({ paymentStatus: 'due', dueBy: DUE_BY }, DUE_BY)).toBe('overdue');
    expect(markOverdue({ paymentStatus: 'paid', dueBy: DUE_BY }, DUE_BY)).toBe('paid');
  });

  it('débit réussi : payée ; on sait si elle était en retard (reprise du programme)', () => {
    expect(
      recordDebitSucceeded({ paymentStatus: 'due', dueBy: DUE_BY }, at('2026-11-24T10:00:00+01:00')),
    ).toEqual({
      paymentStatus: 'paid',
      paidAt: at('2026-11-24T10:00:00+01:00'),
      wasOverdue: false,
    });
    expect(recordDebitSucceeded({ paymentStatus: 'due', dueBy: DUE_BY }, DUE_BY)).toMatchObject({
      wasOverdue: true,
    });
    expect(recordDebitSucceeded({ paymentStatus: 'overdue', dueBy: DUE_BY }, DUE_BY)).toMatchObject({
      paymentStatus: 'paid',
      wasOverdue: true,
    });
  });

  it('cas limite : une séance déjà payée ne l’est pas deux fois', () => {
    expect(() => recordDebitSucceeded({ paymentStatus: 'paid', dueBy: DUE_BY }, DUE_BY)).toThrow(
      expect.objectContaining({ code: 'CLEANING_INVALID_TRANSITION', details: { from: 'paid', to: 'paid' } }),
    );
  });

  it('compte des séances en retard d’un programme, lu d’après l’heure', () => {
    const lines = [
      { paymentStatus: 'overdue' as const, dueBy: null },
      { paymentStatus: 'due' as const, dueBy: DUE_BY },
      { paymentStatus: 'paid' as const, dueBy: DUE_BY },
    ];
    expect(countOverdue(lines, at('2026-11-24T10:59:59+01:00'))).toBe(1);
    expect(countOverdue(lines, DUE_BY)).toBe(2);
  });
});
