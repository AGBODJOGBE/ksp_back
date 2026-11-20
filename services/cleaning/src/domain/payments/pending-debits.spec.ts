import { debitsToRelaunch, relaunchOrder, sessionPendingKind } from './pending-debits';

const at = (iso: string) => new Date(iso);
const debit = (
  kind: 'visit_fee' | 'overdue_session' | 'due_session',
  objectId: string,
  amount: number,
  since: string,
) => ({
  kind,
  objectId,
  amount,
  since: at(since),
});

const FEE = debit('visit_fee', 'fee-1', 5_000, '2026-11-25T10:00:00+01:00');
const LATE_OLD = debit('overdue_session', 's-2', 15_000, '2026-11-16T11:00:00+01:00');
const LATE_NEW = debit('overdue_session', 's-3', 15_000, '2026-11-23T11:00:00+01:00');
const DUE = debit('due_session', 's-4', 15_000, '2026-11-30T11:00:00+01:00');

describe('ordre des débits relancés par une recharge (R-FV-02, R-PP-03, RV-93)', () => {
  it('frais de visite, séances en retard, séances à payer, de la plus ancienne à la plus récente', () => {
    expect(relaunchOrder([DUE, LATE_NEW, FEE, LATE_OLD]).map((line) => line.objectId)).toEqual([
      'fee-1',
      's-2',
      's-3',
      's-4',
    ]);
  });

  it('à date égale, ordre stable par identifiant', () => {
    const twin = { ...LATE_OLD, objectId: 's-1' };
    expect(relaunchOrder([LATE_OLD, twin]).map((line) => line.objectId)).toEqual(['s-1', 's-2']);
  });
});

describe('débits que le solde couvre', () => {
  it('recharge de 35 000 : frais de visite et deux retards, la séance à payer attend', () => {
    expect(debitsToRelaunch(35_000, [DUE, LATE_NEW, FEE, LATE_OLD]).map((line) => line.objectId)).toEqual([
      'fee-1',
      's-2',
      's-3',
    ]);
  });

  it('solde juste égal : couvert ; un franc de moins : rien', () => {
    expect(debitsToRelaunch(5_000, [FEE])).toEqual([FEE]);
    expect(debitsToRelaunch(4_999, [FEE])).toEqual([]);
  });

  it('un débit trop grand n’empêche pas les suivants que le solde couvre', () => {
    const big = debit('overdue_session', 's-1', 40_000, '2026-11-09T11:00:00+01:00');
    expect(debitsToRelaunch(20_000, [big, DUE]).map((line) => line.objectId)).toEqual(['s-4']);
  });
});

describe('nature d’une séance en attente, lue d’après l’heure', () => {
  const dueBy = at('2026-12-01T11:00:00+01:00');
  it('à payer avant l’échéance, en retard à l’échéance pile, sinon hors attente', () => {
    expect(sessionPendingKind('due', dueBy, at('2026-12-01T10:59:59+01:00'))).toBe('due_session');
    expect(sessionPendingKind('due', dueBy, dueBy)).toBe('overdue_session');
    expect(sessionPendingKind('overdue', null, dueBy)).toBe('overdue_session');
    expect(sessionPendingKind('paid', dueBy, dueBy)).toBeNull();
  });
});
