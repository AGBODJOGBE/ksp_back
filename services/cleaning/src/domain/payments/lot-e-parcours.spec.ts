import { resumeSessions } from '../programs/catch-up';
import { addSuspensionCause, liftSuspensionCause, overdueSuspensionDecision } from '../programs/suspension';
import { addSessionPhoto, arriveAtSession, startSession, updateChecklist } from '../sessions/field-steps';
import { completeSession } from '../sessions/field-outcomes';
import type { FieldSession } from '../sessions/session';
import { fieldSession } from '../sessions/testing';
import { chargeSession, sessionInvoiceDraft } from './charge';
import { countOverdue, debitDecision, markOverdue, recordDebitSucceeded } from './debit';
import type { SessionPaymentStatus } from './payment-status';
import { debitsToRelaunch } from './pending-debits';
import type { StartPaymentContext } from './start-gate';

/**
 * Critère du lot E (partie 18) : « 15 séances donnent 15 débits et 15 factures ; une séance en
 * retard bloque la suivante et le paiement la débloque ». Programme hebdomadaire d'un particulier :
 * 15 lundis à 9 h (Porto-Novo) à partir du 23 novembre 2026, 15 000 FCFA la séance, 5 000 FCFA de
 * frais de visite à déduire du premier paiement.
 */
const MIN = 60_000;
const WEEK = 7 * 24 * 60 * MIN;
const FIRST = new Date('2026-11-23T09:00:00+01:00');
const PRICE = 15_000;
const SETTINGS = { arrivalMaxAdvanceMinutes: 30, arrivalAlertMeters: 300 };
const plus = (date: Date, minutes: number) => new Date(date.getTime() + minutes * MIN);

interface Ledger {
  balance: number;
  visitFeeToDeduct: number;
  debits: string[];
  invoices: string[];
  payments: Map<
    string,
    { paymentStatus: SessionPaymentStatus; dueBy: Date | null; netAmount: number; since: Date }
  >;
}

const newLedger = (balance: number): Ledger => ({
  balance,
  visitFeeToDeduct: 5_000,
  debits: [],
  invoices: [],
  payments: new Map(),
});

function sessionAt(rank: number): FieldSession {
  const start = new Date(FIRST.getTime() + (rank - 1) * WEEK);
  return fieldSession({ id: `s-${rank}`, scheduledStart: start, scheduledEnd: plus(start, 120) });
}

function gate(ledger: Ledger): StartPaymentContext {
  const programSessions = [...ledger.payments].map(([sessionId, line]) => ({ sessionId, ...line }));
  return {
    payerKind: 'individual',
    programSessions,
    balanceGuarantee: false,
    balance: ledger.balance,
    expectedAmount: PRICE,
  };
}

/** Débite la séance si le solde la couvre ; la facture est émise au paiement. */
function tryDebit(ledger: Ledger, rank: number, now: Date): void {
  const id = `s-${rank}`;
  const line = ledger.payments.get(id)!;
  const decision = debitDecision({ id, rank, sessionsCount: 15, attempt: 1, ...line }, ledger.balance, now);
  if (decision.action !== 'debit') return;
  ledger.balance -= decision.amount;
  ledger.debits.push(decision.idempotencyKey);
  recordDebitSucceeded(line, now);
  ledger.payments.set(id, { ...line, paymentStatus: 'paid' });
  const deduction = rank === 1 ? 5_000 : 0;
  ledger.invoices.push(
    sessionInvoiceDraft({
      sessionId: id,
      rank,
      sessionsCount: 15,
      amountDue: PRICE,
      visitFeeDeduction: deduction,
    }).idempotencyKey,
  );
}

/** Séance réalisée par l'équipe, de l'arrivée à la clôture, puis débit automatique. */
function realize(ledger: Ledger, session: FieldSession, rank: number): FieldSession {
  const start = session.scheduledStart;
  const agentId = 'agent-1';
  let s = arriveAtSession(session, {
    agentId,
    now: plus(start, -10),
    position: null,
    place: null,
    settings: SETTINGS,
  });
  s = addSessionPhoto(s, {
    agentId,
    kind: 'before',
    fileId: `b-${rank}`,
    now: plus(start, -5),
    maxPerKind: 10,
  });
  s = startSession(s, { agentId, now: start, payment: gate(ledger) });
  const items = s.checklist.map((point) => ({
    cleaningTypeCode: point.cleaningTypeCode,
    code: point.code,
    checked: true,
  }));
  s = updateChecklist(s, { agentId, now: plus(start, 60), items });
  s = addSessionPhoto(s, {
    agentId,
    kind: 'after',
    fileId: `a-${rank}`,
    now: plus(start, 100),
    maxPerKind: 10,
  });
  s = completeSession(s, { agentId, now: plus(start, 115) });
  const charge = chargeSession({
    price: PRICE,
    outcome: { kind: 'completed' },
    payerKind: 'individual',
    paymentStatus: 'not_due',
    visitFeeToDeduct: ledger.visitFeeToDeduct,
    lateFeePercent: 50,
    graceHours: 24,
    now: s.completedAt!,
  });
  ledger.visitFeeToDeduct = charge.remainingVisitFeeToDeduct;
  const status = charge.paymentStatus as SessionPaymentStatus;
  ledger.payments.set(s.id, {
    paymentStatus: status,
    dueBy: charge.dueBy,
    netAmount: charge.netAmount,
    since: s.completedAt!,
  });
  tryDebit(ledger, rank, s.completedAt!);
  return s;
}

describe('critère du lot E', () => {
  it('15 séances donnent 15 débits et 15 factures', () => {
    const ledger = newLedger(1_000_000);
    for (let rank = 1; rank <= 15; rank += 1)
      expect(realize(ledger, sessionAt(rank), rank).status).toBe('completed');
    expect(ledger.debits).toHaveLength(15);
    expect(new Set(ledger.debits).size).toBe(15);
    expect(ledger.debits[0]).toBe('cleaning_session:s-1');
    expect(ledger.invoices).toHaveLength(15);
    expect(ledger.balance).toBe(1_000_000 - (15 * PRICE - 5_000));
  });

  it('une séance en retard bloque la suivante et le paiement la débloque', () => {
    const ledger = newLedger(3 * PRICE - 5_000);
    for (let rank = 1; rank <= 3; rank += 1) realize(ledger, sessionAt(rank), rank);
    expect(ledger.balance).toBe(0);

    // Séance 4 (lundi 14 décembre) réalisée, solde nul : « à payer » jusqu'au 15 à 10 h 55.
    realize(ledger, sessionAt(4), 4);
    const line4 = ledger.payments.get('s-4')!;
    expect(line4).toMatchObject({ paymentStatus: 'due', dueBy: new Date('2026-12-15T10:55:00+01:00') });

    // À l'échéance pile : « en retard » ; le programme est suspendu, la séance 5 gelée.
    const overdueAt = line4.dueBy!;
    ledger.payments.set('s-4', { ...line4, paymentStatus: markOverdue(line4, overdueAt)! });
    const lines = [...ledger.payments.values()];
    const decision = overdueSuspensionDecision({
      status: 'in_progress',
      causes: [],
      overdueCount: countOverdue(lines, overdueAt),
      threshold: 1,
    });
    expect(decision).toBe('add');
    const session5 = sessionAt(5);
    const program = { status: 'in_progress' as const, causes: [], suspendedAt: null };
    const suspended = addSuspensionCause(
      program,
      [{ id: 's-5', status: 'assigned', agentIds: ['agent-1'] }],
      { cause: 'overdue_sessions', now: overdueAt },
    );
    expect(suspended.suspendedSessionIds).toEqual(['s-5']);

    // La séance 5 ne peut pas démarrer tant que la séance 4 est en retard.
    const ready5 = {
      ...session5,
      arrivedAt: plus(session5.scheduledStart, -10),
      beforePhotoFileIds: ['b-5'],
    };
    expect(() =>
      startSession(ready5, { agentId: 'agent-1', now: session5.scheduledStart, payment: gate(ledger) }),
    ).toThrow(
      expect.objectContaining({ code: 'CLEANING_SESSION_OVERDUE_PAYMENT', details: { sessionIds: ['s-4'] } }),
    );

    // Recharge de 30 000 le 16 décembre à 10 h : le retard est débité, le programme reprend.
    const paidAt = new Date('2026-12-16T10:00:00+01:00');
    ledger.balance += 30_000;
    const pending = [
      { kind: 'overdue_session' as const, objectId: 's-4', amount: line4.netAmount, since: line4.since },
    ];
    expect(debitsToRelaunch(ledger.balance, pending).map((debit) => debit.objectId)).toEqual(['s-4']);
    tryDebit(ledger, 4, paidAt);
    expect(ledger.payments.get('s-4')?.paymentStatus).toBe('paid');
    const after = overdueSuspensionDecision({
      status: 'suspended',
      causes: suspended.program.causes,
      overdueCount: countOverdue([...ledger.payments.values()], paidAt),
      threshold: 1,
    });
    expect(after).toBe('lift');
    expect(
      liftSuspensionCause(suspended.program, [{ status: 'completed' }], { cause: 'overdue_sessions' }),
    ).toMatchObject({
      effect: 'resumed',
      program: { status: 'in_progress' },
    });
    const resumed = resumeSessions({
      sessions: [
        {
          id: 's-5',
          rank: 5,
          status: 'suspended',
          scheduledStart: session5.scheduledStart,
          scheduledEnd: session5.scheduledEnd,
        },
      ],
      now: paidAt,
      firstSessionLeadHours: 48,
      excludedDays: new Set(),
      maxWeeks: 8,
    });
    expect(resumed.toAssign).toEqual(['s-5']);

    // Réaffectée, la séance 5 démarre et se paie normalement.
    expect(realize(ledger, session5, 5).status).toBe('completed');
    expect(ledger.debits).toHaveLength(5);
    expect(ledger.invoices).toHaveLength(5);
  });
});
