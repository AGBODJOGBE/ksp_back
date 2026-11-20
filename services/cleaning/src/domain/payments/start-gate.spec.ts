import {
  assertPaymentAllowsStart,
  DEFAULT_BALANCE_GUARANTEE,
  overdueSessionsBlockingStart,
} from './start-gate';

const at = (iso: string) => new Date(iso);
/** Démarrage de la séance 4, lundi 30 novembre 2026 à 9 h (Porto-Novo). */
const NOW = at('2026-11-30T09:00:00+01:00');
const line = (sessionId: string, paymentStatus: 'not_due' | 'due' | 'paid' | 'overdue', dueBy?: string) => ({
  sessionId,
  paymentStatus,
  dueBy: dueBy ? at(dueBy) : null,
});

const context = (overrides: Partial<Parameters<typeof assertPaymentAllowsStart>[1]> = {}) => ({
  payerKind: 'individual' as const,
  programSessions: [line('s1', 'paid'), line('s2', 'paid'), line('s3', 'paid'), line('s4', 'not_due')],
  balanceGuarantee: false,
  balance: 0,
  expectedAmount: 15_000,
  ...overrides,
});

describe('une séance en retard bloque la suivante (R-PP-04)', () => {
  it('toutes les séances précédentes payées : le démarrage passe, même solde nul', () => {
    expect(() => assertPaymentAllowsStart('s4', context(), NOW)).not.toThrow();
  });

  it('séance 3 en retard : CLEANING_SESSION_OVERDUE_PAYMENT', () => {
    const sessions = [line('s1', 'paid'), line('s2', 'paid'), line('s3', 'overdue'), line('s4', 'not_due')];
    expect(() => assertPaymentAllowsStart('s4', context({ programSessions: sessions }), NOW)).toThrow(
      expect.objectContaining({ code: 'CLEANING_SESSION_OVERDUE_PAYMENT', details: { sessionIds: ['s3'] } }),
    );
  });

  it('statut lu d’après l’heure : échéance pile à maintenant bloque, une seconde après non', () => {
    const due = (dueBy: string) => [line('s3', 'due', dueBy), line('s4', 'not_due')];
    expect(overdueSessionsBlockingStart('s4', due('2026-11-30T09:00:00+01:00'), NOW)).toEqual(['s3']);
    expect(overdueSessionsBlockingStart('s4', due('2026-11-30T09:00:01+01:00'), NOW)).toEqual([]);
  });

  it('entreprise : réglée par la facture mensuelle, jamais bloquée ici', () => {
    expect(() => assertPaymentAllowsStart('s4', null, NOW)).not.toThrow();
  });
});

describe('garantie de solde (R-PP-05)', () => {
  it('désactivée par défaut', () => {
    expect(DEFAULT_BALANCE_GUARANTEE).toBe(false);
  });

  it('activée : solde égal au montant attendu passe ; un franc de moins est refusé', () => {
    const guarded = { balanceGuarantee: true, expectedAmount: 15_000 };
    expect(() => assertPaymentAllowsStart('s4', context({ ...guarded, balance: 15_000 }), NOW)).not.toThrow();
    expect(() => assertPaymentAllowsStart('s4', context({ ...guarded, balance: 14_999 }), NOW)).toThrow(
      expect.objectContaining({ code: 'CLEANING_BALANCE_GUARANTEE_NOT_MET', details: { amountDue: 15_000 } }),
    );
  });

  it('le retard passe avant la garantie', () => {
    const sessions = [line('s3', 'overdue'), line('s4', 'not_due')];
    expect(() =>
      assertPaymentAllowsStart('s4', context({ programSessions: sessions, balanceGuarantee: true }), NOW),
    ).toThrow(expect.objectContaining({ code: 'CLEANING_SESSION_OVERDUE_PAYMENT' }));
  });
});
