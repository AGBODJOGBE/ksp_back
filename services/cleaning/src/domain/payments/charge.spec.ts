import {
  amountDue,
  chargePercent,
  chargeSession,
  expectedSessionAmount,
  sessionDebitKey,
  sessionDebitLabel,
  sessionInvoiceDraft,
} from './charge';

const at = (iso: string) => new Date(iso);
/** Clôture le lundi 23 novembre 2026 à 11 h (Porto-Novo). */
const NOW = at('2026-11-23T11:00:00+01:00');
const COMPLETED = { kind: 'completed' } as const;
const charge = (overrides: Partial<Parameters<typeof chargeSession>[0]> = {}) =>
  chargeSession({
    price: 15_000,
    outcome: COMPLETED,
    payerKind: 'individual',
    paymentStatus: 'not_due',
    visitFeeToDeduct: 0,
    lateFeePercent: 50,
    graceHours: 24,
    now: NOW,
    ...overrides,
  });

describe('part du prix due (R-PP-01, R-EX-02, partie 12)', () => {
  it('réalisée : 100 % ; client absent ou annulation tardive : 50 %', () => {
    expect(chargePercent(COMPLETED, 50)).toBe(100);
    expect(chargePercent({ kind: 'missed', cause: 'customer_absent' }, 50)).toBe(50);
    expect(chargePercent({ kind: 'cancelled', cause: 'customer_late' }, 50)).toBe(50);
  });

  it('rien à payer : annulation par le client à temps, par KSP, faute d’agent, arrêt du programme', () => {
    for (const cause of ['customer', 'ksp', 'no_agent', 'program_stopped'] as const) {
      expect(chargePercent({ kind: 'cancelled', cause }, 50)).toBe(0);
    }
  });

  it('accès impossible : rien n’est facturé tant que la règle n’est pas fixée', () => {
    expect(chargePercent({ kind: 'missed', cause: 'access_impossible' }, 50)).toBe(0);
  });

  it('50 % arrondis au franc, moitié vers le haut ; taux réglé à 0 % ou 100 %', () => {
    const absent = { kind: 'missed', cause: 'customer_absent' } as const;
    expect(amountDue(15_000, absent, 50)).toBe(7_500);
    expect(amountDue(15_001, absent, 50)).toBe(7_501);
    expect(amountDue(15_001, absent, 0)).toBe(0);
    expect(amountDue(15_001, absent, 100)).toBe(15_001);
  });
});

describe('montant dû et débit à la clôture (R-PP-01, R-PP-02, R-PP-03)', () => {
  it('séance réalisée : son prix est dû, à payer sous 24 h', () => {
    expect(charge()).toEqual({
      amountDue: 15_000,
      visitFeeDeduction: 0,
      netAmount: 15_000,
      paymentStatus: 'due',
      dueBy: at('2026-11-24T11:00:00+01:00'),
      remainingVisitFeeToDeduct: 0,
    });
  });

  it('frais de visite de 5 000 déduits du premier paiement', () => {
    expect(charge({ visitFeeToDeduct: 5_000 })).toMatchObject({
      amountDue: 15_000,
      visitFeeDeduction: 5_000,
      netAmount: 10_000,
      remainingVisitFeeToDeduct: 0,
    });
  });

  it('frais plus grands que le montant dû : le reste passe aux séances suivantes', () => {
    const first = charge({ price: 4_000, visitFeeToDeduct: 5_000 });
    expect(first).toMatchObject({
      visitFeeDeduction: 4_000,
      netAmount: 0,
      paymentStatus: 'paid',
      dueBy: null,
    });
    expect(first.remainingVisitFeeToDeduct).toBe(1_000);
    const second = charge({ price: 4_000, visitFeeToDeduct: first.remainingVisitFeeToDeduct });
    expect(second).toMatchObject({
      visitFeeDeduction: 1_000,
      netAmount: 3_000,
      remainingVisitFeeToDeduct: 0,
    });
  });

  it('client absent : 50 % dus, la déduction porte sur ce montant', () => {
    const absent = charge({ outcome: { kind: 'missed', cause: 'customer_absent' }, visitFeeToDeduct: 5_000 });
    expect(absent).toMatchObject({ amountDue: 7_500, visitFeeDeduction: 5_000, netAmount: 2_500 });
  });

  it('rien à payer : le paiement reste « non dû », les frais restent à déduire', () => {
    const free = charge({ outcome: { kind: 'cancelled', cause: 'ksp' }, visitFeeToDeduct: 5_000 });
    expect(free).toMatchObject({
      amountDue: 0,
      paymentStatus: 'not_due',
      dueBy: null,
      remainingVisitFeeToDeduct: 5_000,
    });
  });

  it('repasse gratuite : reste dispensée', () => {
    expect(charge({ price: 0, paymentStatus: 'waived' })).toMatchObject({
      amountDue: 0,
      paymentStatus: 'waived',
    });
  });

  it('entreprise : montant dû et déduction calculés pour la facture mensuelle, sans statut ni échéance', () => {
    expect(charge({ payerKind: 'organization', paymentStatus: null, visitFeeToDeduct: 5_000 })).toEqual({
      amountDue: 15_000,
      visitFeeDeduction: 5_000,
      netAmount: 10_000,
      paymentStatus: null,
      dueBy: null,
      remainingVisitFeeToDeduct: 0,
    });
  });

  it('une séance déjà à payer ne se facture pas deux fois', () => {
    expect(() => charge({ paymentStatus: 'due' })).toThrow(
      expect.objectContaining({ code: 'CLEANING_INVALID_TRANSITION', details: { from: 'due', to: 'due' } }),
    );
  });
});

describe('montant attendu avant la séance (R-PP-05, R-WL-06)', () => {
  it('prix moins les frais qui restent à déduire, jamais négatif', () => {
    expect(expectedSessionAmount(15_000, 0)).toBe(15_000);
    expect(expectedSessionAmount(15_000, 5_000)).toBe(10_000);
    expect(expectedSessionAmount(4_000, 5_000)).toBe(0);
  });
});

describe('objet du débit et facture (R-WL-03, R-PP-01, R-PP-06)', () => {
  it('clé tirée de la séance, numérotée à partir de la deuxième tentative', () => {
    expect(sessionDebitKey('s-3')).toBe('cleaning_session:s-3');
    expect(sessionDebitKey('s-3', 1)).toBe('cleaning_session:s-3');
    expect(sessionDebitKey('s-3', 2)).toBe('cleaning_session:s-3:2');
    expect(() => sessionDebitKey('s-3', 0)).toThrow(
      expect.objectContaining({ code: 'CLEANING_VALIDATION_FAILED' }),
    );
  });

  it('objet lisible « Nettoyage — séance 3/15 »', () => {
    expect(sessionDebitLabel(3, 15)).toBe('Nettoyage — séance 3/15');
  });

  it('facture : ligne de la séance, frais de visite déduits, total, clé fixe', () => {
    expect(
      sessionInvoiceDraft({
        sessionId: 's-1',
        rank: 1,
        sessionsCount: 15,
        amountDue: 15_000,
        visitFeeDeduction: 5_000,
      }),
    ).toEqual({
      idempotencyKey: 'cleaning_session_invoice:s-1',
      lines: [{ label: 'Nettoyage — séance 1/15', amount: 15_000 }],
      visitFeeDeduction: 5_000,
      total: 10_000,
    });
  });
});
