import { programProgress } from '../../domain/programs/program-status';
import { resumeSessions } from '../../domain/programs/catch-up';
import {
  addSuspensionCause,
  liftSuspensionCause,
  type SuspensionCauseCode,
} from '../../domain/programs/suspension';
import { countOverdue } from '../../domain/payments/debit';
import { addHours } from '../../domain/requests/time';
import { type balanceAlert } from '../../domain/payments/balance-alerts';
import { type AuditEntry, type OutboxMessage } from '../ports';
import { type ExecutionTx, type ProgramRecord, type SessionRecord } from './execution.ports';

/**
 * Outils communs du lot E : champs communs des événements, suspension et reprise appliquées dans
 * une transaction, progression du programme. Chaque fonction rend les événements et les traces à
 * écrire avec l'état (outbox, journal d'audit), jamais avant.
 */

/** R-SU-03 : la recherche d'une date de rattrapage s'arrête à 8 semaines (décision du responsable). */
export const CATCH_UP_MAX_WEEKS = 8;

/** Auteur des écritures des tâches automatiques (journal d'audit). */
export const SYSTEM_ACTOR = 'system';

export const xof = (amount: number) => ({ amount, currency: 'XOF' as const });

export interface Effects {
  events: OutboxMessage[];
  audit: AuditEntry[];
}

export const noEffects = (): Effects => ({ events: [], audit: [] });

export function merge(...parts: Effects[]): Effects {
  return { events: parts.flatMap((part) => part.events), audit: parts.flatMap((part) => part.audit) };
}

/** Champs communs des événements de séance. */
export function sessionFields(program: ProgramRecord, session: Pick<SessionRecord, 'id' | 'rank'>) {
  return {
    sessionId: session.id,
    programId: program.id,
    customerId: program.customerId,
    organizationId: program.organizationId,
    programNumber: program.number,
    rank: session.rank,
    sessionsCount: program.sessionsCount,
  };
}

export function programFields(program: ProgramRecord) {
  return { programId: program.id, customerId: program.customerId, organizationId: program.organizationId };
}

/** Titulaire du wallet débité (R-WL-01) : le compte ou l'organisation du programme. */
export function holderOf(program: Pick<ProgramRecord, 'ownerKind' | 'ownerId'>) {
  return { type: program.ownerKind, id: program.ownerId } as const;
}

export function audit(
  actorId: string,
  action: string,
  entity: { type: 'program' | 'session'; id: string },
  at: Date,
  details?: Record<string, unknown>,
): AuditEntry {
  return {
    actorId,
    action,
    entityType: entity.type,
    entityId: entity.id,
    at,
    ...(details ? { details } : {}),
  };
}

/** Programme verrouillé et relu avec ses séances (début de toute décision du lot E). */
export async function lockedProgram(
  tx: ExecutionTx,
  programId: string,
): Promise<{ program: ProgramRecord; sessions: SessionRecord[] }> {
  await tx.lockProgram(programId);
  const program = await tx.program(programId);
  if (!program) throw new Error(`Programme ${programId} introuvable.`);
  return { program, sessions: await tx.programSessions(programId) };
}

/**
 * Ajout d'une cause de suspension (R-SU-01, R-SU-02) : programme suspendu, séances à venir gelées,
 * agents libérés ; ou cause cumulée sur un programme déjà suspendu.
 */
export async function applyAddCause(
  tx: ExecutionTx,
  program: ProgramRecord,
  sessions: readonly SessionRecord[],
  input: {
    cause: SuspensionCauseCode;
    now: Date;
    reason?: string | null;
    decidedBy?: string | null;
    overdueCount?: number | null;
    threshold?: number | null;
  },
): Promise<Effects & { effect: 'suspended' | 'cause_added' | 'none' }> {
  const decision = addSuspensionCause(
    { status: program.status, causes: program.causes, suspendedAt: program.suspendedAt },
    sessions.map((session) => ({
      id: session.id,
      status: session.status,
      agentIds: session.agents.map((agent) => agent.agentId),
    })),
    input,
  );
  if (decision.effect === 'none') return { ...noEffects(), effect: 'none' };
  const added = decision.program.causes.at(-1)!;
  await tx.addCause(
    program.id,
    added,
    decision.effect === 'suspended' ? { status: 'suspended', suspendedAt: input.now } : undefined,
  );
  const actor = input.decidedBy ?? SYSTEM_ACTOR;
  const causes = decision.program.causes.map((cause) => cause.cause);
  if (decision.effect === 'cause_added') {
    return {
      effect: 'cause_added',
      events: [
        {
          type: 'cleaning.program.suspension_updated',
          payload: {
            ...programFields(program),
            change: 'cause_added',
            cause: input.cause,
            causes,
            unpaidCount: null,
            overdueCount: input.overdueCount ?? null,
            updatedAt: input.now.toISOString(),
          },
        },
      ],
      audit: [
        audit(actor, 'program.cause_added', { type: 'program', id: program.id }, input.now, {
          cause: input.cause,
        }),
      ],
    };
  }
  for (const id of decision.suspendedSessionIds) {
    await tx.updateSession(id, null, { status: 'suspended' });
  }
  const released = await tx.releaseAssignments(decision.suspendedSessionIds, {
    by: input.decidedBy ?? null,
    reason: 'program_suspended',
    at: input.now,
  });
  return {
    effect: 'suspended',
    events: [
      {
        type: 'cleaning.program.suspended',
        payload: {
          ...programFields(program),
          causes,
          suspendedSessionIds: decision.suspendedSessionIds,
          releasedAgentIds: released,
          suspendedAt: input.now.toISOString(),
          communeKey: program.communeKey,
          unpaidCount: null,
          overdueCount: input.overdueCount ?? null,
          threshold: input.threshold ?? null,
        },
      },
    ],
    audit: [
      audit(actor, 'program.suspended', { type: 'program', id: program.id }, input.now, {
        cause: input.cause,
        suspendedSessionIds: decision.suspendedSessionIds,
      }),
    ],
  };
}

/** Rattrapage proposé à la reprise (R-SU-03) ; null : aucune date trouvée dans les 8 semaines. */
export interface CatchUp {
  sessionId: string;
  rank: number;
  previousStart: Date;
  suggestedStart: Date | null;
}

/**
 * Levée d'une cause (R-SU-01). Dernière cause : le programme reprend, les séances suspendues à
 * venir repassent « à affecter », les autres reçoivent une date de rattrapage (R-SU-03).
 */
export async function applyLiftCause(
  tx: ExecutionTx,
  program: ProgramRecord,
  sessions: readonly SessionRecord[],
  input: {
    cause: SuspensionCauseCode;
    now: Date;
    liftedBy: string | null;
    firstSessionLeadHours: number;
    overdueCount?: number | null;
  },
): Promise<Effects & { effect: 'resumed' | 'cause_lifted' | 'none'; catchUp: CatchUp[] }> {
  const decision = liftSuspensionCause(
    { status: program.status, causes: program.causes, suspendedAt: program.suspendedAt },
    sessions,
    { cause: input.cause },
  );
  if (decision.effect === 'none') return { ...noEffects(), effect: 'none', catchUp: [] };
  await tx.liftCause(
    program.id,
    input.cause,
    input.now,
    input.liftedBy,
    decision.effect === 'resumed' ? { status: decision.program.status, suspendedAt: null } : undefined,
  );
  const actor = input.liftedBy ?? SYSTEM_ACTOR;
  const entity = { type: 'program' as const, id: program.id };
  if (decision.effect === 'cause_lifted') {
    return {
      effect: 'cause_lifted',
      catchUp: [],
      events: [
        {
          type: 'cleaning.program.suspension_updated',
          payload: {
            ...programFields(program),
            change: 'cause_lifted',
            cause: input.cause,
            causes: decision.program.causes.map((cause) => cause.cause),
            unpaidCount: null,
            overdueCount: input.overdueCount ?? null,
            updatedAt: input.now.toISOString(),
          },
        },
      ],
      audit: [audit(actor, 'program.cause_lifted', entity, input.now, { cause: input.cause })],
    };
  }
  const lastSession = sessions.reduce<Date>(
    (latest, session) => (session.scheduledEnd > latest ? session.scheduledEnd : latest),
    input.now,
  );
  const plan = program.schedulePlan as { excludedDates?: unknown } | null;
  const excluded = new Set<string>([
    ...(Array.isArray(plan?.excludedDates) ? (plan!.excludedDates as string[]) : []),
    ...(await tx.holidays(input.now, addHours(lastSession, 24 * 7 * (CATCH_UP_MAX_WEEKS + 1)))),
  ]);
  const resumed = resumeSessions({
    sessions,
    now: input.now,
    firstSessionLeadHours: input.firstSessionLeadHours,
    excludedDays: excluded,
    maxWeeks: CATCH_UP_MAX_WEEKS,
  });
  for (const id of resumed.toAssign) await tx.updateSession(id, null, { status: 'to_assign' });
  for (const proposal of resumed.catchUp) {
    await tx.updateSession(proposal.sessionId, null, { catchUpSuggestedStart: proposal.suggestedStart });
  }
  return {
    effect: 'resumed',
    catchUp: resumed.catchUp,
    events: [
      {
        type: 'cleaning.program.resumed',
        payload: {
          ...programFields(program),
          sessionsToAssign: resumed.toAssign.length,
          catchUpSessionIds: resumed.catchUp.map((proposal) => proposal.sessionId),
          resumedAt: input.now.toISOString(),
          communeKey: program.communeKey,
          liftedCause: input.cause,
        },
      },
    ],
    audit: [
      audit(actor, 'program.resumed', entity, input.now, {
        cause: input.cause,
        sessionsToAssign: resumed.toAssign,
        catchUp: resumed.catchUp.map((proposal) => proposal.sessionId),
      }),
    ],
  };
}

/**
 * R-PP-04 : réévalue la cause « séances en retard » d'un programme de particulier d'après le nombre
 * de séances en retard (statut lu d'après l'heure) et le seuil réglé.
 */
export async function reevaluateOverdue(
  tx: ExecutionTx,
  program: ProgramRecord,
  sessions: readonly SessionRecord[],
  input: { now: Date; threshold: number; firstSessionLeadHours: number },
): Promise<Effects & { catchUp: CatchUp[] }> {
  if (program.payerKind !== 'individual') return { ...noEffects(), catchUp: [] };
  const overdueCount = countOverdue(sessions, input.now);
  const active = program.causes.some((cause) => cause.cause === 'overdue_sessions');
  if (
    !active &&
    overdueCount >= input.threshold &&
    program.status !== 'completed' &&
    program.status !== 'cancelled'
  ) {
    const added = await applyAddCause(tx, program, sessions, {
      cause: 'overdue_sessions',
      now: input.now,
      overdueCount,
      threshold: input.threshold,
    });
    return { events: added.events, audit: added.audit, catchUp: [] };
  }
  if (active && overdueCount < input.threshold) {
    const lifted = await applyLiftCause(tx, program, sessions, {
      cause: 'overdue_sessions',
      now: input.now,
      liftedBy: null,
      firstSessionLeadHours: input.firstSessionLeadHours,
      overdueCount,
    });
    return { events: lifted.events, audit: lifted.audit, catchUp: lifted.catchUp };
  }
  return { ...noEffects(), catchUp: [] };
}

/**
 * Progression du programme d'après ses séances (partie 8) : « en cours » dès une séance démarrée,
 * « terminé » quand toutes sont closes (événement cleaning.program.completed).
 */
export async function applyProgress(
  tx: ExecutionTx,
  program: ProgramRecord,
  sessions: readonly Pick<SessionRecord, 'status'>[],
  now: Date,
): Promise<Effects> {
  const path = programProgress(program.status, sessions);
  if (path.length === 0) return noEffects();
  const final = path.at(-1)!;
  await tx.updateProgram(program.id, {
    status: final,
    ...(final === 'completed' ? { completedAt: now } : {}),
  });
  if (final !== 'completed') return noEffects();
  const count = (status: string) => sessions.filter((session) => session.status === status).length;
  return {
    events: [
      {
        type: 'cleaning.program.completed',
        payload: {
          ...programFields(program),
          sessionsCompleted: count('completed'),
          sessionsMissed: count('missed'),
          sessionsCancelled: count('cancelled'),
          completedAt: now.toISOString(),
          programNumber: program.number,
          planKind: program.planKind,
        },
      },
    ],
    audit: [],
  };
}

/** R-WL-06 : solde qui ne couvre plus la séance (cleaning.session.balance_insufficient). */
export function balanceInsufficientEvent(
  program: ProgramRecord,
  session: SessionRecord,
  alert: NonNullable<ReturnType<typeof balanceAlert>>,
): OutboxMessage {
  return {
    type: 'cleaning.session.balance_insufficient',
    payload: {
      ...sessionFields(program, session),
      scheduledStart: session.scheduledStart.toISOString(),
      amountDue: xof(alert.amountDue),
      missing: xof(alert.missing),
      guaranteeRequired: alert.guaranteeRequired,
      trigger: alert.trigger,
      detectedAt: alert.detectedAt.toISOString(),
    },
  };
}
