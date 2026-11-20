import { paySession as planPayment } from '../../domain/payments/direct-payment';
import { type ProgramStatus, PROGRAM_STATUSES } from '../../domain/programs/program-status';
import { stopProgramByCustomer } from '../../domain/programs/program-stop';
import { cancelSessionByCustomer } from '../../domain/sessions/cancellation';
import { ExecutionRuleError, invalidTransition } from '../../domain/sessions/errors';
import { customerReschedulesInMonth, rescheduleByCustomer } from '../../domain/sessions/reschedule';
import { SESSION_STATUSES, type SessionStatus } from '../../domain/sessions/session-status';
import { type ExecutionDeps } from '../deps';
import { cleaningErrors } from '../shared/errors';
import { runIdempotent } from '../shared/idempotency';
import { instant, optionalInstant, page, requireUuid, text } from '../shared/input';
import { type Page, pageOf, parsePage } from '../shared/paging';
import { type CustomerScope, currentCustomer, inScope, requireOrganizationRole } from './customer-access';
import { executionAction } from './execution-actions';
import { executionError, executionErrors, guarded } from './execution-errors';
import { type ProgramRecord, type SessionRecord } from './execution.ports';
import { audit, holderOf, merge, programFields } from './execution-support';
import { applyCancellation, applyReschedule, type ChangeContext } from './session-changes';
import { netAmount, SessionPayments } from './session-payments';
import { type SessionDetails, sessionDetails } from './session-views';

/**
 * Espace client : programmes et séances (UC-NT-11 à 14, 16). Le client agit seul jusqu'à 24 h avant
 * une séance (partie 12) ; organisation : « org_member » au moins, « org_admin » pour arrêter un
 * programme (R-CP-03). Un dossier hors du contexte actif répond « introuvable ».
 */

/** Résultat de PaySession (valeurs du contrat PaymentOutcome). */
export interface PaymentOutcomeView {
  status: 'paid' | 'awaiting_payment';
  amount: number;
  walletTransactionId: string | null;
  paymentId: string | null;
  checkoutUrl: string | null;
  invoiceId: string | null;
}

/** Durée d'une page de paiement chez payment, bornée ensuite par l'échéance de la séance (R-PP-07). */
const PAGE_HOURS = 72;

export class CustomerProgramUseCases {
  private readonly payments: SessionPayments;

  constructor(private readonly deps: ExecutionDeps) {
    this.payments = new SessionPayments(deps);
  }

  async listPrograms(input: {
    status?: string;
    limit?: number;
    cursor?: string;
  }): Promise<Page<ProgramRecord>> {
    const scope = currentCustomer();
    const status = input.status || null;
    if (status && !PROGRAM_STATUSES.includes(status as ProgramStatus)) {
      throw cleaningErrors.invalid('status', 'invalid_type');
    }
    const request = page(input.limit, input.cursor);
    return this.deps.execution.listPrograms(
      { ownerKind: scope.ownerKind, ownerId: scope.ownerId, status: status as ProgramStatus | null },
      request,
    );
  }

  async getProgram(programId: string): Promise<ProgramRecord> {
    return this.scopedProgram(currentCustomer(), programId);
  }

  async listSessions(input: {
    programId: string;
    status?: string;
    from?: string;
    to?: string;
    limit?: number;
    cursor?: string;
  }): Promise<Page<SessionDetails>> {
    const program = await this.scopedProgram(currentCustomer(), input.programId);
    if (input.status && !SESSION_STATUSES.includes(input.status as SessionStatus)) {
      throw cleaningErrors.invalid('status', 'invalid_type');
    }
    const from = optionalInstant(input.from, 'from');
    const to = optionalInstant(input.to, 'to');
    const sessions = (await this.deps.execution.programSessions(program.id)).filter(
      (session) =>
        (!input.status || session.status === input.status) &&
        (!from || session.scheduledStart >= from) &&
        (!to || session.scheduledStart < to),
    );
    const selected = pageOf(sessions, parsePage(input));
    return {
      ...selected,
      items: await Promise.all(
        selected.items.map((session) => sessionDetails(this.deps, session, { program })),
      ),
    };
  }

  async getSession(sessionId: string): Promise<SessionDetails> {
    const { program, session } = await this.scopedSession(currentCustomer(), sessionId);
    return sessionDetails(this.deps, session, { program });
  }

  /** UC-NT-12, R-RP-01 : report par le client, plus de 24 h avant, 2 par mois au plus. */
  async reschedule(input: {
    sessionId: string;
    idempotencyKey: string;
    newStart: string;
  }): Promise<SessionDetails> {
    const scope = currentCustomer();
    requireOrganizationRole(scope, 'org_member');
    const { program, session } = await this.scopedSession(scope, input.sessionId);
    const newStart = instant(input.newStart, 'newStart');
    return executionAction(this.deps, this.payments, {
      actorId: scope.userId,
      operation: 'session.reschedule',
      key: input.idempotencyKey,
      body: { sessionId: session.id, newStart: newStart.toISOString() },
      programId: program.id,
      sessionId: session.id,
      view: () => this.getSession(session.id),
      decide: async (ctx) => {
        const history = ctx.sessions.flatMap((line) => line.reschedules);
        const moved = rescheduleByCustomer(ctx.session, {
          programStatus: ctx.program.status,
          programCauses: ctx.program.causes.map((cause) => cause.cause),
          programSessions: ctx.sessions,
          newStart,
          actorId: scope.userId,
          now: ctx.now,
          freeCancellationHours: ctx.settings.freeCancellationHours,
          reschedulesPerMonth: ctx.settings.maxReschedulesPerMonth,
          reschedulesThisMonth: customerReschedulesInMonth(history, ctx.now),
        });
        return applyReschedule(ctx, moved);
      },
    });
  }

  /** UC-NT-12, partie 12 : annulation par le client plus de 24 h avant, rien à payer. */
  async cancelSession(input: { sessionId: string; idempotencyKey: string }): Promise<SessionDetails> {
    const scope = currentCustomer();
    requireOrganizationRole(scope, 'org_member');
    const { program, session } = await this.scopedSession(scope, input.sessionId);
    return executionAction(this.deps, this.payments, {
      actorId: scope.userId,
      operation: 'session.cancel',
      key: input.idempotencyKey,
      body: { sessionId: session.id },
      programId: program.id,
      sessionId: session.id,
      view: () => this.getSession(session.id),
      decide: async (ctx) => {
        const cancelled = cancelSessionByCustomer(ctx.session, {
          actorId: scope.userId,
          now: ctx.now,
          freeCancellationHours: ctx.settings.freeCancellationHours,
        });
        const change = await applyCancellation(this.payments, ctx, cancelled, scope.userId);
        return { ...change, collect: [] };
      },
    });
  }

  /**
   * UC-NT-13 : arrêt par le client (« org_admin » pour une organisation). Les séances réalisées
   * restent dues ; les séances à venir sont annulées, sauf la plus proche si elle est à moins de 24 h.
   */
  async stopProgram(input: { programId: string; idempotencyKey: string }): Promise<ProgramRecord> {
    const scope = currentCustomer();
    requireOrganizationRole(scope, 'org_admin');
    const program = await this.scopedProgram(scope, input.programId);
    return executionAction(this.deps, this.payments, {
      actorId: scope.userId,
      operation: 'program.stop',
      key: input.idempotencyKey,
      body: { programId: program.id },
      programId: program.id,
      view: () => this.getProgram(program.id),
      decide: async (ctx) => {
        const stop = stopProgramByCustomer(ctx.program, ctx.sessions, {
          now: ctx.now,
          freeCancellationHours: ctx.settings.freeCancellationHours,
        });
        return stopEffects(ctx, stop.cancelledSessionIds, {
          by: 'customer',
          actorId: scope.userId,
          reason: null,
          approvedBy: null,
        });
      },
    });
  }

  /**
   * UC-NT-14 : payer une séance « à payer » ou « en retard » (R-PP-03, R-WL-05). Wallet : débit du
   * montant dû. Mobile Money : paiement de ce qui manque au solde, crédité au wallet, puis débit à
   * la réception de wallet.prepaid.credited ; une page en cours est renvoyée telle quelle.
   */
  async paySession(input: {
    sessionId: string;
    idempotencyKey: string;
    method: string;
  }): Promise<PaymentOutcomeView> {
    const scope = currentCustomer();
    requireOrganizationRole(scope, 'org_member');
    if (input.method !== 'wallet' && input.method !== 'mobile_money') {
      throw cleaningErrors.invalid('method', 'invalid_type');
    }
    const method = input.method;
    const { program, session } = await this.scopedSession(scope, input.sessionId);
    const now = this.deps.clock.now();
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: scope.userId,
      operation: 'session.pay',
      key: input.idempotencyKey,
      body: { sessionId: session.id, method },
      at: now,
      replay: async (response) => response as unknown as PaymentOutcomeView,
      run: async (stub) => {
        const outcome = await guarded(() => this.pay(program, session, method, now));
        await this.deps.execution.transaction((tx) =>
          tx.write({ events: [], audit: [], idempotency: stub({ ...outcome }) }),
        );
        return outcome;
      },
    });
  }

  private async pay(
    program: ProgramRecord,
    session: SessionRecord,
    method: 'wallet' | 'mobile_money',
    now: Date,
  ): Promise<PaymentOutcomeView> {
    const amount = netAmount(session);
    const balance =
      program.payerKind === 'individual' ? await this.deps.balances.balance(holderOf(program)) : 0;
    const directPayments = await this.deps.execution.directPayments(session.id);
    const plan = planPayment({
      payerKind: program.payerKind,
      paymentStatus: session.paymentStatus,
      dueBy: session.dueBy,
      netAmount: amount,
      balance,
      method,
      directPayments: directPayments.map((payment) => ({
        id: payment.id,
        status: payment.status,
        amount: payment.amount,
        checkoutUrl: null,
        expiresAt: payment.expiresAt,
        debited: payment.status === 'succeeded' && session.paymentStatus === 'paid',
      })),
      providerExpiry: new Date(now.getTime() + PAGE_HOURS * 3_600_000),
      now,
    });
    const awaiting = (
      paymentId: string | null,
      checkoutUrl: string | null,
      value: number,
    ): PaymentOutcomeView => ({
      status: 'awaiting_payment',
      amount: value,
      walletTransactionId: null,
      paymentId,
      checkoutUrl,
      invoiceId: null,
    });
    if (plan.kind === 'debit_wallet') {
      const result = await this.payments.collect(session.id, 'pay');
      if (result.outcome === 'awaiting') {
        throw executionError(
          new ExecutionRuleError('CLEANING_INSUFFICIENT_BALANCE', {
            missing: result.missing ?? amount - balance,
          }),
        );
      }
      if (result.outcome !== 'paid') throw executionErrors.sessionNotFound();
      const paid = await this.deps.execution.session(session.id);
      return {
        status: 'paid',
        amount,
        walletTransactionId: result.walletTransactionId,
        paymentId: null,
        checkoutUrl: null,
        invoiceId: paid?.invoiceId ?? null,
      };
    }
    if (plan.kind === 'awaiting_payment') return awaiting(null, null, amount - balance);
    const existing =
      plan.kind === 'existing_page' ? directPayments.find((line) => line.id === plan.payment.id)! : null;
    const record = existing ?? {
      id: this.deps.ids.next(),
      idempotencyKey: `cleaning_session:${session.id}:pay:${directPayments.length + 1}`,
      amount: plan.kind === 'new_page' ? plan.amount : amount - balance,
      expiresAt: plan.kind === 'new_page' ? plan.expiresAt : null,
    };
    if (!existing) {
      await this.deps.execution.transaction((tx) =>
        tx.insertDirectPayment({
          id: record.id,
          idempotencyKey: record.idempotencyKey,
          payerKind: program.ownerKind,
          payerId: program.ownerId,
          amount: record.amount,
          requestId: program.requestId,
          sessionId: session.id,
          expiresAt: record.expiresAt,
          createdAt: now,
        }),
      );
    }
    // Même clé : payment rend la page encore ouverte (RV-90).
    const page = await this.deps.directPayments.create({
      idempotencyKey: record.idempotencyKey,
      customerId: program.customerId,
      organizationId: program.organizationId,
      amount: record.amount,
      target: {
        objectType: 'cleaning_session',
        objectId: session.id,
        reference: `séance ${session.rank}/${program.sessionsCount}`,
      },
      description: `Nettoyage — séance ${session.rank}/${program.sessionsCount}`,
      expiresAt: record.expiresAt,
    });
    await this.deps.execution.transaction((tx) =>
      tx.updateDirectPayment(record.id, {
        paymentRequestId: page.paymentId,
        expiresAt: page.expiresAt ?? record.expiresAt,
      }),
    );
    return awaiting(page.paymentId, page.checkoutUrl, record.amount);
  }

  /** UC-NT-16 : note d'une séance réalisée, 1 à 5 étoiles, une seule fois (R-RC-05). */
  async rateSession(input: {
    sessionId: string;
    idempotencyKey: string;
    stars: number;
    comment?: string | null;
  }): Promise<SessionDetails> {
    const scope = currentCustomer();
    requireOrganizationRole(scope, 'org_member');
    const { program, session } = await this.scopedSession(scope, input.sessionId);
    if (!Number.isInteger(input.stars) || input.stars < 1 || input.stars > 5) {
      throw cleaningErrors.invalid('stars', 'out_of_range');
    }
    const comment = text(input.comment, 'comment');
    return executionAction(this.deps, this.payments, {
      actorId: scope.userId,
      operation: 'session.rate',
      key: input.idempotencyKey,
      body: { sessionId: session.id, stars: input.stars, comment },
      programId: program.id,
      sessionId: session.id,
      view: () => this.getSession(session.id),
      decide: async (ctx) => {
        if (ctx.session.status !== 'completed')
          throw invalidTransition(ctx.session.status, ctx.session.status);
        if (ctx.session.rating) throw executionErrors.ratingAlreadyGiven();
        const rated =
          ctx.session.staffClosure?.presentAgentIds ?? ctx.session.agents.map((agent) => agent.agentId);
        await ctx.tx.rateAgents(rated, input.stars);
        return {
          patch: { rating: { stars: input.stars, comment, ratedAt: ctx.now } },
          effects: { events: [], audit: [] },
        };
      },
    });
  }

  private async scopedProgram(scope: CustomerScope, programId: string): Promise<ProgramRecord> {
    const program = await this.deps.execution.program(requireUuid(programId, 'programId'));
    if (!program || !inScope(scope, program)) throw executionErrors.programNotFound();
    return program;
  }

  private async scopedSession(scope: CustomerScope, sessionId: string) {
    const session = await this.deps.execution.session(requireUuid(sessionId, 'sessionId'));
    const program = session ? await this.deps.execution.program(session.programId) : null;
    if (!session || !program || !inScope(scope, program)) throw executionErrors.sessionNotFound();
    return { program, session };
  }
}

/**
 * Arrêt d'un programme (client ou KSP) : séances à venir annulées (cause program_stopped), agents
 * libérés, programme annulé (cleaning.program.cancelled). Les séances réalisées restent dues.
 */
export async function stopEffects(
  ctx: ChangeContext,
  cancelledSessionIds: readonly string[],
  stop: { by: 'customer' | 'ksp'; actorId: string; reason: string | null; approvedBy: string | null },
) {
  const { tx, program, now } = ctx;
  for (const id of cancelledSessionIds) {
    await tx.updateSession(id, null, {
      status: 'cancelled',
      cancellation: {
        by: stop.by,
        cause: 'program_stopped',
        late: false,
        at: now,
        reason: null,
        actorId: stop.actorId,
      },
      catchUpSuggestedStart: null,
    });
  }
  const released = await tx.releaseAssignments(cancelledSessionIds, {
    by: stop.actorId,
    reason: 'program_cancelled',
    at: now,
  });
  await tx.updateProgram(program.id, {
    status: 'cancelled',
    cancellation: { at: now, by: stop.by, reason: stop.reason, approvedBy: stop.approvedBy },
  });
  for (const cause of program.causes) await tx.liftCause(program.id, cause.cause, now, stop.actorId);
  return {
    effects: merge({
      events: [
        {
          type: 'cleaning.program.cancelled',
          payload: {
            ...programFields(program),
            cancelledBy: stop.by,
            cancelledByUserId: stop.actorId,
            cancelledSessionIds: [...cancelledSessionIds],
            cancelledAt: now.toISOString(),
            releasedAgentIds: released,
          },
        },
      ],
      audit: [
        audit(stop.actorId, 'program.cancelled', { type: 'program', id: program.id }, now, {
          by: stop.by,
          cancelledSessionIds,
          ...(stop.approvedBy ? { approvedBy: stop.approvedBy } : {}),
        }),
      ],
    }),
  };
}
