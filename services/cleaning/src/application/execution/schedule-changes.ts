import { type ScheduleChange } from '../../domain/programs/schedule-change';
import { type SchedulePlan } from '../../domain/schedule-plan/plan';
import { type OutboxMessage } from '../ports';
import { audit, type Effects, sessionFields } from './execution-support';
import { type ChangeContext } from './session-changes';

/**
 * Changement de plan d'un programme (R-PG-06, R-RP-01), appliqué sous le verrou du programme :
 * chaque séance déplacée garde son identifiant, son rang, son prix et son paiement ; son ancienne
 * date entre dans l'historique des reports, ses agents sont retirés (séance « à affecter »).
 *
 * Événements : un `cleaning.session.rescheduled` par séance déplacée (aucun regroupement n'existe
 * dans les schémas) ; le retrait des agents suit par `cleaning.session.unassigned`, cause
 * « rescheduled », qui n'envoie aucun message de plus.
 */
export async function applyScheduleChange(
  ctx: ChangeContext,
  change: ScheduleChange,
  input: { plan: SchedulePlan; effectiveFrom: string; reason: string; actorId: string },
): Promise<Effects> {
  const { tx, program, now } = ctx;
  if (change.moves.length === 0) return { events: [], audit: [] };
  const events: OutboxMessage[] = [];
  for (const move of change.moves) {
    const session = ctx.sessions.find((line) => line.id === move.sessionId)!;
    const released = await tx.releaseAssignments([session.id], {
      by: input.actorId,
      reason: 'rescheduled',
      at: now,
    });
    await tx.updateSession(session.id, session.version, {
      status: move.status,
      scheduledStart: move.scheduledStart,
      scheduledEnd: move.scheduledEnd,
      catchUpSuggestedStart: null,
    });
    await tx.insertReschedule(session.id, move.reschedule);
    events.push({
      type: 'cleaning.session.rescheduled',
      payload: {
        ...sessionFields(program, session),
        previousStart: move.reschedule.previousStart.toISOString(),
        scheduledStart: move.scheduledStart.toISOString(),
        scheduledEnd: move.scheduledEnd.toISOString(),
        rescheduledBy: 'ksp',
        rescheduledAt: now.toISOString(),
        agentIds: [],
        releasedAgentIds: released,
        durationMinutes: Math.round((move.scheduledEnd.getTime() - move.scheduledStart.getTime()) / 60_000),
      },
    });
    if (released.length) {
      events.push({
        type: 'cleaning.session.unassigned',
        payload: {
          ...sessionFields(program, session),
          agentIds: released,
          cause: 'rescheduled',
          unassignedAt: now.toISOString(),
          scheduledStart: move.scheduledStart.toISOString(),
          batchId: null,
        },
      });
    }
  }
  await tx.updateProgram(program.id, {
    schedulePlan: input.plan,
    ...(change.durationMinutes !== null ? { durationMinutes: change.durationMinutes } : {}),
  });
  return {
    events,
    audit: [
      audit(input.actorId, 'program.schedule_changed', { type: 'program', id: program.id }, now, {
        previousPlan: program.schedulePlan,
        newPlan: input.plan,
        effectiveFrom: input.effectiveFrom,
        reason: input.reason,
        sessionIds: change.moves.map((move) => move.sessionId),
        ...(change.durationMinutes !== null
          ? { previousDurationMinutes: program.durationMinutes, durationMinutes: change.durationMinutes }
          : {}),
      }),
    ],
  };
}
