import { AppError } from '@ksp/platform';
import {
  chargeSession,
  expectedSessionAmount,
  sessionDebitKey,
  sessionDebitLabel,
  sessionInvoiceDraft,
  type SessionCharge,
  type SessionOutcome,
} from '../../domain/payments/charge';
import { recordDebitSucceeded } from '../../domain/payments/debit';
import { effectivePaymentStatus, isPayable } from '../../domain/payments/payment-status';
import { debitsToRelaunch, sessionPendingKind } from '../../domain/payments/pending-debits';
import { localDay } from '../../domain/requests/time';
import { balanceAlert, nextPlannedSession } from '../../domain/payments/balance-alerts';
import { type ExecutionDeps } from '../deps';
import {
  type ExecutionSettings,
  type ExecutionTx,
  type OwnerKind,
  type ProgramRecord,
  type SessionPatch,
  type SessionRecord,
} from './execution.ports';
import {
  audit,
  balanceInsufficientEvent,
  type Effects,
  holderOf,
  lockedProgram,
  reevaluateOverdue,
  sessionFields,
  SYSTEM_ACTOR,
  xof,
} from './execution-support';

/**
 * Paiement d'une séance de particulier (partie 11.1, UC-NT-46) : montant dû à la clôture, débit du
 * wallet avec la clé tirée de la séance (R-PP-01), attente si le solde manque (R-PP-03), retard et
 * suspension (R-PP-04), relance à chaque recharge (RV-93), facture de séance émise par billing au
 * paiement (R-PP-06). Une opération envoyée au wallet est enregistrée « en cours » avant l'appel
 * (15.4) : une panne entre le débit et son enregistrement est reprise par la tâche, avec la même clé.
 */
export type CollectOutcome =
  | { outcome: 'paid'; walletTransactionId: string | null }
  | { outcome: 'awaiting'; missing: number | null }
  | { outcome: 'pending' }
  | { outcome: 'none' };

export type CollectTrigger = 'close' | 'pay' | 'recharge' | 'replay';

const INSUFFICIENT = 'WALLET_INSUFFICIENT_FUNDS';

/** Montant net d'une séance due : montant dû moins les frais de visite déduits. */
export const netAmount = (session: Pick<SessionRecord, 'amountDue' | 'visitFeeDeducted'>) =>
  (session.amountDue ?? 0) - session.visitFeeDeducted;

export class SessionPayments {
  constructor(private readonly deps: ExecutionDeps) {}

  /**
   * Charge d'une séance close (réalisée, manquée, annulée tard), dans la transaction de la clôture :
   * montant dû, déduction des frais de visite, statut de paiement. Rend la charge, pour les
   * événements cleaning.session.completed / missed.
   */
  async chargeOnClose(
    tx: ExecutionTx,
    program: ProgramRecord,
    session: SessionRecord,
    outcome: SessionOutcome,
    settings: ExecutionSettings,
    now: Date,
  ): Promise<{ charge: SessionCharge; patch: SessionPatch }> {
    const charge = chargeSession({
      price: session.price,
      outcome,
      payerKind: program.payerKind,
      paymentStatus: program.payerKind === 'individual' ? (session.paymentStatus ?? 'not_due') : null,
      visitFeeToDeduct: program.visitFeeToDeduct,
      lateFeePercent: settings.lateCancellationFeePct,
      graceHours: settings.sessionPaymentGraceHours,
      now,
    });
    if (charge.remainingVisitFeeToDeduct !== program.visitFeeToDeduct) {
      await tx.updateProgram(program.id, { visitFeeToDeduct: charge.remainingVisitFeeToDeduct });
      program.visitFeeToDeduct = charge.remainingVisitFeeToDeduct;
    }
    return {
      charge,
      patch: {
        amountDue: charge.amountDue,
        visitFeeDeducted: charge.visitFeeDeduction,
        paymentStatus: charge.paymentStatus,
        dueBy: charge.dueBy,
        ...(charge.paymentStatus === 'paid' ? { paidAt: now } : {}),
      },
    };
  }

  /**
   * Débit du wallet pour une séance « à payer » ou « en retard ». Solde insuffisant : la séance
   * attend (à la clôture, le client est prévenu : cleaning.session.payment_due). Panne de wallet :
   * l'opération reste « en cours », reprise par la tâche avec la même clé.
   */
  async collect(sessionId: string, trigger: CollectTrigger): Promise<CollectOutcome> {
    const session = await this.deps.execution.session(sessionId);
    if (!session) return { outcome: 'none' };
    const now = this.deps.clock.now();
    const prepared = await this.deps.execution.transaction(async (tx) => {
      const { program, sessions } = await lockedProgram(tx, session.programId);
      const current = sessions.find((line) => line.id === sessionId)!;
      if (program.payerKind !== 'individual') return null;
      if (!isPayable(effectivePaymentStatus(current.paymentStatus, current.dueBy, now))) return null;
      const amount = netAmount(current);
      const operations = await tx.walletOperations(sessionId);
      const label = sessionDebitLabel(current.rank, program.sessionsCount);
      const running = operations.find((operation) => operation.status === 'pending');
      if (running) return { program, session: current, operation: running, label };
      const refunded = operations.filter((operation) => operation.failureCode === 'WALLET_DEBIT_REFUNDED');
      const attempt = refunded.length + 1;
      const previous = operations.find((operation) => operation.attempt === attempt);
      if (previous) {
        await tx.reopenWalletOperation(previous.id, amount, now);
        return { program, session: current, operation: { ...previous, amount }, label };
      }
      const operation = {
        id: this.deps.ids.next(),
        idempotencyKey: sessionDebitKey(sessionId, attempt),
        attempt,
        walletOwnerKind: program.ownerKind,
        walletOwnerId: program.ownerId,
        amount,
        label,
        requestId: program.requestId,
        sessionId,
        createdAt: now,
      };
      await tx.insertWalletOperation(operation);
      return { program, session: current, operation: { ...operation, status: 'pending' as const }, label };
    });
    if (!prepared) return { outcome: 'none' };
    const { program, operation, label } = prepared;
    let transactionId: string;
    try {
      const debit = await this.deps.wallet.debit({
        idempotencyKey: operation.idempotencyKey,
        holder: holderOf(program),
        amount: operation.amount,
        // Une nouvelle tentative suit un débit remboursé : l'objet n'a toujours qu'un débit actif.
        object: { objectType: 'cleaning_session', objectId: sessionId, part: '' },
        description: label,
      });
      transactionId = debit.transactionId;
    } catch (error) {
      if (error instanceof AppError && error.code === INSUFFICIENT) {
        const missing = Number((error.details as { missing?: unknown } | undefined)?.missing ?? NaN);
        await this.recordFailure(sessionId, operation.id, trigger, now);
        return { outcome: 'awaiting', missing: Number.isFinite(missing) ? missing : null };
      }
      // Panne ou refus inattendu : l'opération reste en cours, reprise par la tâche (15.4).
      return { outcome: 'pending' };
    }
    await this.recordSuccess(sessionId, operation.id, transactionId);
    await this.issueInvoice(sessionId).catch(() => undefined);
    await this.alertNextSession(session.programId).catch(() => undefined);
    return { outcome: 'paid', walletTransactionId: transactionId };
  }

  /** Solde insuffisant : opération échouée ; à la clôture, le client est invité à payer. */
  private async recordFailure(sessionId: string, operationId: string, trigger: CollectTrigger, now: Date) {
    const session = (await this.deps.execution.session(sessionId))!;
    await this.deps.execution.transaction(async (tx) => {
      const { program, sessions } = await lockedProgram(tx, session.programId);
      const current = sessions.find((line) => line.id === sessionId)!;
      await tx.completeWalletOperation(operationId, {
        status: 'failed',
        walletTransactionId: null,
        failureCode: INSUFFICIENT,
        at: now,
      });
      const effects: Effects = {
        events: [],
        audit: [
          audit(SYSTEM_ACTOR, 'money.debit_failed', { type: 'session', id: sessionId }, now, {
            reason: INSUFFICIENT,
            trigger,
          }),
        ],
      };
      if (trigger === 'close' && current.dueBy) {
        effects.events.push({
          type: 'cleaning.session.payment_due',
          payload: {
            ...sessionFields(program, current),
            amountDue: xof(netAmount(current)),
            dueBy: current.dueBy.toISOString(),
            scheduledStart: current.scheduledStart.toISOString(),
          },
        });
        effects.audit.push(
          audit(SYSTEM_ACTOR, 'money.payment_due', { type: 'session', id: sessionId }, now, {
            amount: netAmount(current),
          }),
        );
      }
      await tx.write(effects);
    });
  }

  /**
   * Débit réussi : séance payée, facture à émettre (R-PP-06) ; si elle était en retard, la cause de
   * suspension est réévaluée et le programme reprend si c'était la dernière (R-PP-04).
   */
  async recordSuccess(sessionId: string, operationId: string, transactionId: string): Promise<void> {
    const session = (await this.deps.execution.session(sessionId))!;
    const now = this.deps.clock.now();
    await this.deps.execution.transaction(async (tx) => {
      const { program, sessions } = await lockedProgram(tx, session.programId);
      const settings = await tx.settings();
      const current = sessions.find((line) => line.id === sessionId)!;
      await tx.completeWalletOperation(operationId, {
        status: 'succeeded',
        walletTransactionId: transactionId,
        failureCode: null,
        at: now,
      });
      const entity = { type: 'session' as const, id: sessionId };
      if (!isPayable(effectivePaymentStatus(current.paymentStatus, current.dueBy, now))) {
        // Déjà réglée : le débit rejoué est le même (clé identique), rien d'autre à faire.
        await tx.write({ events: [], audit: [] });
        return;
      }
      const paid = recordDebitSucceeded(current, now);
      await tx.updateSession(sessionId, null, { paymentStatus: 'paid', paidAt: paid.paidAt });
      const after = sessions.map((line) =>
        line.id === sessionId ? { ...line, paymentStatus: 'paid' as const, paidAt: paid.paidAt } : line,
      );
      const overdue = paid.wasOverdue
        ? await reevaluateOverdue(tx, program, after, {
            now,
            threshold: settings.overdueSessionsBeforeSuspension,
            firstSessionLeadHours: settings.firstSessionLeadHours,
          })
        : { events: [], audit: [] };
      await tx.write({
        events: [
          {
            type: 'cleaning.session.paid',
            payload: {
              ...sessionFields(program, current),
              amountPaid: xof(netAmount(current)),
              visitFeeDeduction: xof(current.visitFeeDeducted),
              walletTransactionId: transactionId,
              invoiceId: null,
              paidAt: now.toISOString(),
            },
          },
          ...overdue.events,
        ],
        audit: [
          audit(SYSTEM_ACTOR, 'money.debit_succeeded', entity, now, {
            amount: netAmount(current),
            walletTransactionId: transactionId,
            wasOverdue: paid.wasOverdue,
          }),
          ...overdue.audit,
        ],
      });
    });
  }

  /**
   * Facture de séance émise par billing (R-PP-06), clé fixe tirée de la séance : rejouée par la tâche
   * tant qu'elle n'est pas confirmée. Rend faux si la séance n'a pas (ou plus) de facture à émettre.
   */
  async issueInvoice(sessionId: string): Promise<boolean> {
    const session = await this.deps.execution.session(sessionId);
    if (!session || session.paymentStatus !== 'paid' || session.invoiceId) return false;
    const program = await this.deps.execution.program(session.programId);
    if (!program || program.payerKind !== 'individual') return false;
    const operations = await this.deps.execution.walletOperations(sessionId);
    const debit = operations.find((operation) => operation.status === 'succeeded');
    const draft = sessionInvoiceDraft({
      sessionId,
      rank: session.rank,
      sessionsCount: program.sessionsCount,
      amountDue: session.amountDue ?? 0,
      visitFeeDeduction: session.visitFeeDeducted,
    });
    const lineKind =
      session.status === 'missed'
        ? 'missed_session'
        : session.status === 'cancelled'
          ? 'late_cancellation'
          : 'session';
    const lines = [
      ...draft.lines.map((line) => ({
        ...line,
        kind: lineKind as 'session' | 'missed_session' | 'late_cancellation',
      })),
      ...(draft.visitFeeDeduction > 0
        ? [
            {
              label: 'Frais de visite déduits',
              amount: -draft.visitFeeDeduction,
              kind: 'visit_fee_deduction' as const,
            },
          ]
        : []),
    ];
    const serviceDay = session.completedAt ?? session.missed?.missedAt ?? session.scheduledStart;
    const { invoiceId } = await this.deps.invoices.issueSessionInvoice({
      idempotencyKey: draft.idempotencyKey,
      customerId: program.customerId,
      sessionId,
      requestNumber: program.requestNumber,
      programNumber: program.number,
      sessionRank: `${session.rank}/${program.sessionsCount}`,
      placeLabel: program.placeName,
      serviceDate: localDay(serviceDay),
      lines,
      payment: {
        reference: debit?.walletTransactionId ?? null,
        amount: draft.total,
        paidAt: session.paidAt ?? this.deps.clock.now(),
      },
    });
    await this.deps.execution.transaction(async (tx) => {
      const current = await tx.session(sessionId);
      if (current && !current.invoiceId) await tx.updateSession(sessionId, null, { invoiceId });
    });
    return true;
  }

  /**
   * RV-93 : une recharge du wallet d'un titulaire relance, dans l'ordre (séances en retard, puis à
   * payer, les plus anciennes d'abord), les débits que le solde couvre. Les frais de visite sont
   * relancés par le lot C.
   */
  async relaunch(holder: { kind: OwnerKind; id: string }): Promise<number> {
    const refs = await this.deps.execution.sessionsAwaitingDebit(holder);
    if (refs.length === 0) return 0;
    const now = this.deps.clock.now();
    const pending = [];
    for (const ref of refs) {
      const session = await this.deps.execution.session(ref.sessionId);
      if (!session) continue;
      const kind = sessionPendingKind(session.paymentStatus, session.dueBy, now);
      if (!kind) continue;
      pending.push({ kind, objectId: session.id, amount: netAmount(session), since: session.dueBy ?? now });
    }
    const balance = await this.deps.balances.balance({ type: holder.kind, id: holder.id });
    let paid = 0;
    for (const debit of debitsToRelaunch(balance, pending)) {
      const result = await this.collect(debit.objectId, 'recharge');
      if (result.outcome === 'paid') paid += 1;
    }
    return paid;
  }

  /**
   * R-WL-06 : après un débit, le client est alerté si son solde ne couvre plus sa prochaine séance
   * prévue (une fois par séance et par jour).
   */
  async alertNextSession(programId: string): Promise<void> {
    const program = await this.deps.execution.program(programId);
    if (!program || program.payerKind !== 'individual') return;
    const sessions = await this.deps.execution.programSessions(programId);
    const now = this.deps.clock.now();
    const next = nextPlannedSession(sessions, now);
    if (!next) return;
    const balance = await this.deps.balances.balance(holderOf(program));
    const settings = await this.deps.execution.settings();
    const alert = balanceAlert({
      payerKind: program.payerKind,
      balance,
      expectedAmount: expectedSessionAmount(next.price, program.visitFeeToDeduct),
      lastAlertedAt: next.balanceAlertedAt,
      trigger: 'debit',
      guaranteeRequired: settings.balanceGuarantee,
      now,
    });
    if (!alert) return;
    await this.deps.execution.transaction(async (tx) => {
      await tx.lockProgram(programId);
      await tx.updateSession(next.id, null, { balanceAlertedAt: now });
      await tx.write({ events: [balanceInsufficientEvent(program, next, alert)], audit: [] });
    });
  }
}
