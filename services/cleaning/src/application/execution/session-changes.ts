import { type CancelledSession } from '../../domain/sessions/cancellation';
import { recheckAgents, type RescheduledSession } from '../../domain/sessions/reschedule';
import { type OrganizationTransaction } from '../organizations/organizations.ports';
import { type OutboxMessage } from '../ports';
import {
  type ExecutionSettings,
  type ExecutionTx,
  type ProgramRecord,
  type SessionPatch,
  type SessionRecord,
} from './execution.ports';
import { applyProgress, audit, type Effects, merge, sessionFields, xof } from './execution-support';
import { type SessionPayments } from './session-payments';

/**
 * Annulation et report d'une séance (partie 12, R-RP-01), communs au client et au back-office :
 * agents libérés ou recontrôlés au nouveau créneau, événements, traces, progression du programme.
 */
export interface ChangeContext {
  tx: ExecutionTx;
  program: ProgramRecord;
  sessions: SessionRecord[];
  session: SessionRecord;
  settings: ExecutionSettings;
  now: Date;
  /** Situation de l'organisation du programme, quand l'action a pris son verrou (RV-85). */
  organization?: OrganizationTransaction | null;
}

export interface ChangeDecision {
  patch: SessionPatch;
  effects: Effects;
  /** Séances à débiter après la transaction. */
  collect: string[];
}

export async function applyCancellation(
  payments: SessionPayments,
  ctx: ChangeContext,
  cancelled: CancelledSession,
  actorId: string | null,
): Promise<ChangeDecision> {
  const { session, program, tx, now } = ctx;
  const released = await tx.releaseAssignments([session.id], {
    by: actorId,
    reason: 'session_cancelled',
    at: now,
  });
  const cancellation = cancelled.cancellation;
  const sessions = ctx.sessions.map((line) =>
    line.id === session.id ? { ...line, status: 'cancelled' as const } : line,
  );
  const progress = await applyProgress(tx, program, sessions, now);
  const events: OutboxMessage[] = [
    {
      type: 'cleaning.session.cancelled',
      payload: {
        ...sessionFields(program, session),
        scheduledStart: session.scheduledStart.toISOString(),
        cancelledBy: cancellation.by,
        cause:
          cancellation.cause === 'ksp' || cancellation.cause === 'no_agent' ? cancellation.cause : 'customer',
        releasedAgentIds: released,
        cancelledAt: now.toISOString(),
      },
    },
  ];
  let patch: SessionPatch = {
    status: 'cancelled',
    cancellation: { ...cancellation, actorId },
    catchUpSuggestedStart: null,
  };
  let collect: string[] = [];
  if (cancellation.cause === 'customer_late') {
    // Partie 12 : annulation tardive par le support, part du prix due (débit et facture comme une
    // séance manquée ; billing reçoit le montant par cleaning.session.missed).
    const charged = await payments.chargeOnClose(
      tx,
      program,
      session,
      { kind: 'cancelled', cause: 'customer_late' },
      ctx.settings,
      now,
    );
    patch = { ...patch, ...charged.patch };
    collect = charged.charge.paymentStatus === 'due' ? [session.id] : [];
    events.push({
      type: 'cleaning.session.missed',
      payload: {
        ...sessionFields(program, session),
        payerKind: program.payerKind,
        placeId: program.placeId,
        scheduledStart: session.scheduledStart.toISOString(),
        price: xof(session.price),
        visitFeeDeduction: xof(charged.charge.visitFeeDeduction),
        amountDue: xof(charged.charge.amountDue),
        cause: 'late_cancellation',
        feeBps: ctx.settings.lateCancellationFeePct * 100,
        missedAt: now.toISOString(),
        communeKey: program.communeKey,
        reportedBy: 'ksp',
      },
    });
  }
  return {
    patch,
    collect,
    effects: merge(progress, {
      events,
      audit: actorId
        ? [
            audit(actorId, 'session.cancelled', { type: 'session', id: session.id }, now, {
              cause: cancellation.cause,
              late: cancellation.late,
              releasedAgentIds: released,
            }),
          ]
        : [],
    }),
  };
}

export async function applyReschedule(
  ctx: ChangeContext,
  moved: RescheduledSession,
): Promise<ChangeDecision> {
  const { session, program, tx, now } = ctx;
  const agentIds = session.agents.map((agent) => agent.agentId);
  const blocked = await tx.blockedAgents(session.id, agentIds, moved.scheduledStart, moved.scheduledEnd);
  const check = recheckAgents({
    status: moved.status,
    teamSize: program.teamSize,
    agents: agentIds.map((agentId) => ({ agentId, passes: !blocked.includes(agentId) })),
  });
  // Une séance interrompue reportée garde son équipe si elle passe au nouveau créneau.
  const status =
    check.status === 'to_assign' && check.keptAgentIds.length >= program.teamSize ? 'assigned' : check.status;
  const removed = check.removedAgentIds.length
    ? await tx.releaseAssignments(
        [session.id],
        { by: moved.reschedule.actorId, reason: 'rescheduled', at: now },
        check.removedAgentIds,
      )
    : [];
  await tx.moveAssignments(session.id, moved.scheduledStart, moved.scheduledEnd);
  await tx.insertReschedule(session.id, moved.reschedule);
  const durationMinutes = Math.round(
    (moved.scheduledEnd.getTime() - moved.scheduledStart.getTime()) / 60_000,
  );
  const events: OutboxMessage[] = [
    {
      type: 'cleaning.session.rescheduled',
      payload: {
        ...sessionFields(program, session),
        previousStart: moved.reschedule.previousStart.toISOString(),
        scheduledStart: moved.scheduledStart.toISOString(),
        scheduledEnd: moved.scheduledEnd.toISOString(),
        rescheduledBy: moved.reschedule.by,
        rescheduledAt: now.toISOString(),
        agentIds: check.keptAgentIds,
        releasedAgentIds: removed,
        durationMinutes,
      },
    },
  ];
  if (removed.length) {
    events.push({
      type: 'cleaning.session.unassigned',
      payload: {
        ...sessionFields(program, session),
        agentIds: removed,
        cause: 'rescheduled',
        unassignedAt: now.toISOString(),
        scheduledStart: moved.scheduledStart.toISOString(),
        batchId: null,
      },
    });
  }
  return {
    patch: {
      status,
      scheduledStart: moved.scheduledStart,
      scheduledEnd: moved.scheduledEnd,
      catchUpSuggestedStart: null,
    },
    collect: [],
    effects: {
      events,
      audit: [
        audit(moved.reschedule.actorId, 'session.rescheduled', { type: 'session', id: session.id }, now, {
          previousStart: moved.reschedule.previousStart.toISOString(),
          newStart: moved.scheduledStart.toISOString(),
          by: moved.reschedule.by,
          ...(moved.reschedule.reason ? { reasonGiven: true } : {}),
          removedAgentIds: removed,
        }),
      ],
    },
  };
}
