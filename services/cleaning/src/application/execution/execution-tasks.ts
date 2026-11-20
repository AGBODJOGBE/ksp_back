import { balanceAlert, isReminderDue, sessionReminder } from '../../domain/payments/balance-alerts';
import { expectedSessionAmount } from '../../domain/payments/charge';
import { countOverdue, markOverdue } from '../../domain/payments/debit';
import { sessionPayability, settleDirectPayment } from '../../domain/payments/direct-payment';
import { staffingAlertToSend } from '../../domain/planning/staffing-alert';
import { cancelForNoAgent } from '../../domain/sessions/cancellation';
import { type ExecutionDeps } from '../deps';
import { type OutboxMessage } from '../ports';
import { type OwnerKind } from './execution.ports';
import {
  audit,
  balanceInsufficientEvent,
  holderOf,
  lockedProgram,
  merge,
  reevaluateOverdue,
  sessionFields,
  SYSTEM_ACTOR,
  xof,
} from './execution-support';
import { applyCancellation } from './session-changes';
import { netAmount, SessionPayments } from './session-payments';

/**
 * Tâches automatiques du lot E (UC-NT-46, SES-01, R-PP-05, R-WL-06) et réception du crédit du wallet
 * (wallet.prepaid.credited v2). Règle commune (partie 14) : lots de 200 au plus ; chaque écriture
 * conditionnée par le statut et l'échéance, dans la transaction de l'outbox, avec l'acteur `system` ;
 * une erreur est isolée, comptée et journalisée sans arrêter la tâche.
 */
export const TASK_BATCH = 200;

/** Une opération de wallet en cours depuis plus de 2 minutes est rejouée avec la même clé (15.4). */
export const WALLET_REPLAY_AFTER_MS = 2 * 60_000;

/** R-PP-06 : facture de séance non confirmée au-delà de 30 minutes, alerte à la finance. */
export const INVOICE_ALERT_AFTER_MS = 30 * 60_000;

export interface TaskReport {
  processed: number;
  failed: number;
}

/** Crédit du wallet reçu (wallet.prepaid.credited v2), champs utiles au lot E. */
export interface WalletCredited {
  holder: { type: OwnerKind; id: string };
  forObject: { service: string; objectType: string; objectId: string } | null;
  paymentId: string | null;
  amount: number;
}

export class ExecutionTasks {
  private readonly payments: SessionPayments;

  constructor(
    private readonly deps: ExecutionDeps,
    private readonly onError: (task: string, error: unknown) => void = () => undefined,
  ) {
    this.payments = new SessionPayments(deps);
  }

  private async each<T>(
    task: string,
    items: readonly T[],
    work: (item: T) => Promise<void>,
  ): Promise<TaskReport> {
    const report = { processed: 0, failed: 0 };
    for (const item of items) {
      try {
        await work(item);
        report.processed += 1;
      } catch (error) {
        report.failed += 1;
        this.onError(task, error);
      }
    }
    return report;
  }

  /** R-PP-04 : séance « à payer » échue → « en retard » ; programme suspendu au seuil. */
  async markOverdue(): Promise<TaskReport> {
    const now = this.deps.clock.now();
    const refs = await this.deps.execution.sessionsPastDue(now, TASK_BATCH);
    return this.each('overdue', refs, (ref) =>
      this.deps.execution.transaction(async (tx) => {
        const { program, sessions } = await lockedProgram(tx, ref.programId);
        const session = sessions.find((line) => line.id === ref.sessionId);
        if (!session || session.paymentStatus !== 'due' || markOverdue(session, now) !== 'overdue') return;
        await tx.updateSession(session.id, session.version, { paymentStatus: 'overdue' });
        const after = sessions.map((line) =>
          line.id === session.id ? { ...line, paymentStatus: 'overdue' as const } : line,
        );
        const settings = await tx.settings();
        const overdueCount = countOverdue(after, now);
        const suspension = await reevaluateOverdue(tx, program, after, {
          now,
          threshold: settings.overdueSessionsBeforeSuspension,
          firstSessionLeadHours: settings.firstSessionLeadHours,
        });
        await tx.write(
          merge(
            {
              events: [
                {
                  type: 'cleaning.session.overdue',
                  payload: {
                    ...sessionFields(program, session),
                    amountDue: xof(netAmount(session)),
                    overdueSince: (session.dueBy ?? now).toISOString(),
                    overdueCount,
                    communeKey: program.communeKey,
                  },
                },
              ],
              audit: [
                audit(SYSTEM_ACTOR, 'money.overdue', { type: 'session', id: session.id }, now, {
                  overdueCount,
                }),
              ],
            },
            suspension,
          ),
        );
      }),
    );
  }

  /**
   * SES-01 (R-PL-06, R-PL-10) : alerte d'une séance sans agent à 48 h et à son début, d'un agent
   * absent 1 h après le début ; annulation par KSP (cause no_agent) d'une séance encore à affecter
   * à sa fin prévue, sans rien à payer.
   */
  async watchStaffing(): Promise<TaskReport> {
    const now = this.deps.clock.now();
    const refs = await this.deps.execution.sessionsToWatch(now, TASK_BATCH);
    return this.each('staffing', refs, (ref) =>
      this.deps.execution.transaction(async (tx) => {
        const { program, sessions } = await lockedProgram(tx, ref.programId);
        const session = sessions.find((line) => line.id === ref.sessionId);
        if (!session) return;
        const settings = await tx.settings();
        const cancelled = cancelForNoAgent(session, now);
        if (cancelled) {
          const change = await applyCancellation(
            this.payments,
            { tx, program, sessions, session, settings, now },
            cancelled,
            null,
          );
          await tx.updateSession(session.id, session.version, change.patch);
          await tx.write(
            merge(change.effects, {
              events: [],
              audit: [
                audit(SYSTEM_ACTOR, 'session.cancelled', { type: 'session', id: session.id }, now, {
                  cause: 'no_agent',
                }),
              ],
            }),
          );
          return;
        }
        const level = staffingAlertToSend(session, session.staffingAlertLevel, now);
        if (!level) return;
        await tx.updateSession(session.id, session.version, { staffingAlertLevel: level });
        await tx.write({
          events: [
            {
              type: 'cleaning.session.staffing_alert',
              payload: {
                ...sessionFields(program, session),
                communeKey: program.communeKey,
                scheduledStart: session.scheduledStart.toISOString(),
                level,
                missingAgents: Math.max(
                  program.teamSize - session.agents.length,
                  level === 'agent_absent' ? 1 : 0,
                ),
                alertedAt: now.toISOString(),
              },
            },
          ],
          audit: [],
        });
      }),
    );
  }

  /**
   * Rappel de la veille (partie 10, R-PP-05), une fois par séance, au client et aux agents : il dit
   * si le solde couvre la séance ; s'il ne la couvre pas, alerte de solde (R-WL-06).
   */
  async sendReminders(): Promise<TaskReport> {
    const now = this.deps.clock.now();
    const refs = await this.deps.execution.sessionsToRemind(
      new Date(now.getTime() + 48 * 3_600_000),
      TASK_BATCH,
    );
    return this.each('reminder', refs, async (ref) => {
      const program = await this.deps.execution.program(ref.programId);
      const session = await this.deps.execution.session(ref.sessionId);
      if (!program || !session || !isReminderDue(session, now)) return;
      const expectedAmount = expectedSessionAmount(session.price, program.visitFeeToDeduct);
      const balance =
        program.payerKind === 'individual' ? await this.deps.walletBalances.balance(holderOf(program)) : 0;
      await this.deps.execution.transaction(async (tx) => {
        await tx.lockProgram(program.id);
        const current = await tx.session(session.id);
        if (!current || !isReminderDue(current, now)) return;
        const settings = await tx.settings();
        const reminder = sessionReminder({
          scheduledStart: current.scheduledStart,
          agentIds: current.agents.map((agent) => agent.agentId),
          payerKind: program.payerKind,
          balance,
          expectedAmount,
          now,
        });
        const events: OutboxMessage[] = [
          {
            type: 'cleaning.session.reminder',
            payload: {
              ...sessionFields(program, current),
              scheduledStart: current.scheduledStart.toISOString(),
              agentIds: reminder.agentIds,
              amountDue: reminder.amountDue === null ? null : xof(reminder.amountDue),
              balanceSufficient: reminder.balanceSufficient,
              remindedAt: now.toISOString(),
            },
          },
        ];
        const alert = balanceAlert({
          payerKind: program.payerKind,
          balance,
          expectedAmount,
          lastAlertedAt: current.balanceAlertedAt,
          trigger: 'assigned',
          guaranteeRequired: settings.balanceGuarantee,
          now,
        });
        if (alert) events.push(balanceInsufficientEvent(program, current, alert));
        await tx.updateSession(current.id, current.version, {
          remindedAt: now,
          ...(alert ? { balanceAlertedAt: now } : {}),
        });
        await tx.write({ events, audit: [] });
      });
    });
  }

  /** R-PP-06 : factures de séance pas encore confirmées par billing, rejouées avec la même clé. */
  async issuePendingInvoices(): Promise<TaskReport> {
    const refs = await this.deps.execution.sessionsAwaitingInvoice(TASK_BATCH);
    const now = this.deps.clock.now();
    return this.each('invoice', refs, async (ref) => {
      try {
        await this.payments.issueInvoice(ref.sessionId);
      } catch (error) {
        // R-PP-06 : la finance est alertée au-delà de 30 minutes sans facture confirmée.
        const session = await this.deps.execution.session(ref.sessionId);
        if (session?.paidAt && now.getTime() - session.paidAt.getTime() > INVOICE_ALERT_AFTER_MS) {
          this.onError(
            'invoice_overdue_alert',
            new Error(
              `ALERTE finance : séance ${ref.sessionId} payée sans facture depuis plus de 30 minutes`,
            ),
          );
        }
        throw error;
      }
    });
  }

  /** 15.4 : débit en cours depuis plus de 2 minutes, rejoué avec la même clé pour connaître son issue. */
  async replayWalletOperations(): Promise<TaskReport> {
    const before = new Date(this.deps.clock.now().getTime() - WALLET_REPLAY_AFTER_MS);
    const operations = await this.deps.execution.pendingWalletOperations(before, TASK_BATCH);
    return this.each('wallet_replay', operations, async (operation) => {
      await this.payments.collect(operation.sessionId!, 'replay');
    });
  }

  /**
   * wallet.prepaid.credited v2 : un crédit qui vise une séance (paiement direct, R-WL-05) la débite
   * aussitôt, ou reste au wallet si elle n'est plus payable (R-PP-07) ; toute recharge relance
   * ensuite les débits en attente du titulaire (RV-93).
   */
  async onWalletCredited(credit: WalletCredited): Promise<void> {
    const target = credit.forObject;
    if (target && target.service === 'cleaning' && target.objectType === 'cleaning_session') {
      await this.settleDirectPayment(credit, target.objectId);
    }
    await this.payments.relaunch({ kind: credit.holder.type, id: credit.holder.id });
  }

  private async settleDirectPayment(credit: WalletCredited, sessionId: string): Promise<void> {
    const session = await this.deps.execution.session(sessionId);
    if (!session) return;
    const now = this.deps.clock.now();
    const payments = await this.deps.execution.directPayments(sessionId);
    const payment =
      (credit.paymentId ? payments.find((line) => line.paymentRequestId === credit.paymentId) : undefined) ??
      payments.find((line) => line.status === 'pending');
    const settlement = settleDirectPayment(sessionPayability(session.paymentStatus));
    if (settlement.outcome === 'debit') {
      if (payment) {
        await this.deps.execution.transaction((tx) =>
          tx.updateDirectPayment(payment.id, { status: 'succeeded', completedAt: now }),
        );
      }
      await this.payments.collect(sessionId, 'recharge');
      return;
    }
    const program = await this.deps.execution.program(session.programId);
    if (!program) return;
    await this.deps.execution.transaction(async (tx) => {
      if (payment) await tx.updateDirectPayment(payment.id, { status: 'left_in_wallet', completedAt: now });
      await tx.write({
        events: [
          {
            type: 'cleaning.direct_payment.left_in_wallet',
            payload: {
              directPaymentId: payment?.id ?? sessionId,
              customerId: program.customerId,
              organizationId: program.organizationId,
              objectType: 'session',
              objectId: sessionId,
              amount: xof(credit.amount),
              cause: settlement.cause,
              leftAt: now.toISOString(),
            },
          },
        ],
        audit: [
          audit(SYSTEM_ACTOR, 'money.left_in_wallet', { type: 'session', id: sessionId }, now, {
            cause: settlement.cause,
            amount: credit.amount,
          }),
        ],
      });
    });
  }
}
