import { hasPermission, requirePermission, requireUser } from '@ksp/platform';
import { type ProgramStatus, PROGRAM_STATUSES } from '../../domain/programs/program-status';
import { cancelProgramByKsp } from '../../domain/programs/program-stop';
import { cancelSessionAsKsp } from '../../domain/sessions/cancellation';
import { ExecutionRuleError, invalidTransition, requireReason } from '../../domain/sessions/errors';
import { resumeSession } from '../../domain/sessions/field-outcomes';
import { rescheduleByKsp } from '../../domain/sessions/reschedule';
import { type MissedCause } from '../../domain/sessions/session';
import { SESSION_STATUSES, type SessionStatus } from '../../domain/sessions/session-status';
import { completeSessionAsKsp, reportSessionMissedAsKsp } from '../../domain/sessions/staff-closure';
import { type ExecutionDeps } from '../deps';
import { requireStaff } from '../shared/access';
import { cleaningErrors } from '../shared/errors';
import { instant, optionalInstant, page, requireUuid, requiredReason } from '../shared/input';
import { type Page, pageOf, parsePage } from '../shared/paging';
import { stopEffects } from './customer-programs.use-cases';
import { executionAction } from './execution-actions';
import { executionErrors } from './execution-errors';
import { type ProgramRecord, type SessionRecord } from './execution.ports';
import { applyAddCause, applyLiftCause, audit, type CatchUp } from './execution-support';
import { closeSession } from './field.use-cases';
import { applyCancellation, applyReschedule } from './session-changes';
import { SessionPayments } from './session-payments';
import { type SessionDetails, sessionDetails } from './session-views';

/**
 * Back-office : programmes et séances (UC-NT-39). Lecture : cleaning.program.read ; décisions :
 * cleaning.program.manage, revérifiées d'après les permissions du jeton (R-RB-05) ; double
 * authentification du back-office. Les montants ne sont rendus qu'avec cleaning.amounts.read.
 */
export const PROGRAM_READ = 'cleaning.program.read';
export const PROGRAM_MANAGE = 'cleaning.program.manage';
export const AMOUNTS_READ = 'cleaning.amounts.read';

export interface StaffSessionDetails extends SessionDetails {
  showAmounts: boolean;
}

export interface ProgramResumptionView {
  program: ProgramRecord;
  catchUp: CatchUp[];
}

/** Membre du back-office avec la permission (dans la zone du dossier si elle est limitée). */
function staffWith(permission: string, communeKey?: string): string {
  const userId = requireStaff();
  requirePermission(permission, communeKey);
  return userId;
}

export function canReadAmounts(): boolean {
  return hasPermission(requireUser(), AMOUNTS_READ);
}

export class AdminProgramUseCases {
  private readonly payments: SessionPayments;

  constructor(private readonly deps: ExecutionDeps) {
    this.payments = new SessionPayments(deps);
  }

  async listPrograms(input: {
    status?: string;
    communeKey?: string;
    payerKind?: string;
    q?: string;
    customerId?: string;
    organizationId?: string;
    limit?: number;
    cursor?: string;
  }): Promise<Page<ProgramRecord>> {
    staffWith(PROGRAM_READ);
    if (input.status && !PROGRAM_STATUSES.includes(input.status as ProgramStatus)) {
      throw cleaningErrors.invalid('status', 'invalid_type');
    }
    if (input.payerKind && input.payerKind !== 'individual' && input.payerKind !== 'organization') {
      throw cleaningErrors.invalid('payerKind', 'invalid_type');
    }
    const owner = input.organizationId
      ? { ownerKind: 'organization' as const, ownerId: requireUuid(input.organizationId, 'organizationId') }
      : input.customerId
        ? { ownerKind: 'user' as const, ownerId: requireUuid(input.customerId, 'customerId') }
        : {};
    return this.deps.execution.listPrograms(
      {
        ...owner,
        status: (input.status || null) as ProgramStatus | null,
        communeKey: input.communeKey || null,
        payerKind: (input.payerKind || null) as 'individual' | 'organization' | null,
        q: input.q?.trim() || null,
      },
      page(input.limit, input.cursor),
    );
  }

  async getProgram(programId: string): Promise<ProgramRecord> {
    const program = await this.program(programId);
    staffWith(PROGRAM_READ, program.communeKey);
    return program;
  }

  async listSessions(input: {
    programId: string;
    status?: string;
    paymentStatus?: string;
    limit?: number;
    cursor?: string;
  }): Promise<Page<StaffSessionDetails>> {
    const program = await this.getProgram(input.programId);
    if (input.status && !SESSION_STATUSES.includes(input.status as SessionStatus)) {
      throw cleaningErrors.invalid('status', 'invalid_type');
    }
    const sessions = (await this.deps.execution.programSessions(program.id)).filter(
      (session) =>
        (!input.status || session.status === input.status) &&
        (!input.paymentStatus || session.paymentStatus === input.paymentStatus),
    );
    const selected = pageOf(sessions, parsePage(input));
    const showAmounts = canReadAmounts();
    return {
      ...selected,
      items: await Promise.all(
        selected.items.map(async (session) => ({
          ...(await sessionDetails(this.deps, session, { program })),
          showAmounts,
        })),
      ),
    };
  }

  async getSession(sessionId: string): Promise<StaffSessionDetails> {
    const { program, session } = await this.session(sessionId);
    staffWith(PROGRAM_READ, program.communeKey);
    return { ...(await sessionDetails(this.deps, session, { program })), showAmounts: canReadAmounts() };
  }

  /** R-SU-01, R-SU-02 : suspension décidée par KSP (cause cumulable, motif obligatoire). */
  async suspendProgram(input: {
    programId: string;
    idempotencyKey: string;
    reason: string;
  }): Promise<ProgramRecord> {
    const program = await this.program(input.programId);
    const staffId = staffWith(PROGRAM_MANAGE, program.communeKey);
    const reason = requiredReason(input.reason);
    return executionAction(this.deps, this.payments, {
      actorId: staffId,
      operation: 'program.suspend',
      key: input.idempotencyKey,
      body: { programId: program.id, reason },
      programId: program.id,
      view: () => this.getProgram(program.id),
      decide: async (ctx) => {
        const added = await applyAddCause(ctx.tx, ctx.program, ctx.sessions, {
          cause: 'ksp_decision',
          now: ctx.now,
          reason,
          decidedBy: staffId,
        });
        return { effects: added };
      },
    });
  }

  /** R-SU-01, R-SU-03 : levée de la cause « décision de KSP » ; reprise si aucune autre ne reste. */
  async resumeProgram(input: {
    programId: string;
    idempotencyKey: string;
    reason?: string;
  }): Promise<ProgramResumptionView> {
    const program = await this.program(input.programId);
    const staffId = staffWith(PROGRAM_MANAGE, program.communeKey);
    return executionAction(this.deps, this.payments, {
      actorId: staffId,
      operation: 'program.resume',
      key: input.idempotencyKey,
      body: { programId: program.id, reason: input.reason ?? null },
      programId: program.id,
      view: () => this.resumption(program.id),
      decide: async (ctx) => {
        if (!ctx.program.causes.some((cause) => cause.cause === 'ksp_decision')) {
          throw invalidTransition(
            ctx.program.status,
            ctx.program.status === 'suspended' ? 'suspended' : 'in_progress',
            'no_ksp_decision',
          );
        }
        const lifted = await applyLiftCause(ctx.tx, ctx.program, ctx.sessions, {
          cause: 'ksp_decision',
          now: ctx.now,
          liftedBy: staffId,
          firstSessionLeadHours: ctx.settings.firstSessionLeadHours,
        });
        return { effects: lifted };
      },
    });
  }

  /**
   * Partie 12, R-RB-02 : demande d'arrêt par KSP, motif obligatoire, en attente d'une deuxième
   * personne. Une demande déjà en attente est renvoyée telle quelle.
   */
  async cancelProgram(input: {
    programId: string;
    idempotencyKey: string;
    reason: string;
  }): Promise<ProgramRecord> {
    const program = await this.program(input.programId);
    const staffId = staffWith(PROGRAM_MANAGE, program.communeKey);
    const reason = requiredReason(input.reason);
    return executionAction(this.deps, this.payments, {
      actorId: staffId,
      operation: 'program.cancel_request',
      key: input.idempotencyKey,
      body: { programId: program.id, reason },
      programId: program.id,
      view: () => this.getProgram(program.id),
      decide: async (ctx) => {
        if (ctx.program.status === 'completed' || ctx.program.status === 'cancelled') {
          throw invalidTransition(ctx.program.status, 'cancelled');
        }
        if (ctx.program.pendingCancellation) return { effects: { events: [], audit: [] } };
        await ctx.tx.updateProgram(ctx.program.id, { cancellationRequestReason: reason });
        return {
          effects: {
            events: [],
            audit: [
              audit(staffId, 'program.cancel_requested', { type: 'program', id: ctx.program.id }, ctx.now),
            ],
          },
        };
      },
    });
  }

  /** Validation de l'arrêt par une deuxième personne : séances à venir annulées sans frais. */
  async approveProgramCancellation(input: {
    programId: string;
    idempotencyKey: string;
  }): Promise<ProgramRecord> {
    const program = await this.program(input.programId);
    const staffId = staffWith(PROGRAM_MANAGE, program.communeKey);
    return executionAction(this.deps, this.payments, {
      actorId: staffId,
      operation: 'program.cancel_approve',
      key: input.idempotencyKey,
      body: { programId: program.id },
      programId: program.id,
      view: () => this.getProgram(program.id),
      decide: async (ctx) => {
        const pending = ctx.program.pendingCancellation;
        if (!pending) throw invalidTransition(ctx.program.status, 'cancelled', 'no_pending_cancellation');
        const decision = cancelProgramByKsp(ctx.program, ctx.sessions, {
          reason: pending.reason,
          requestedBy: pending.requestedBy,
          approvedBy: staffId,
        });
        return stopEffects(ctx, decision.cancelledSessionIds, {
          by: 'ksp',
          actorId: staffId,
          reason: pending.reason,
          approvedBy: staffId,
        });
      },
    });
  }

  /** R-RP-01, R-SU-03 : report par KSP (motif, durée modifiable, rattrapage après la reprise). */
  async rescheduleSession(input: {
    sessionId: string;
    idempotencyKey: string;
    newStart: string;
    reason: string;
    durationMinutes?: number | null;
  }): Promise<StaffSessionDetails> {
    const { program, session } = await this.session(input.sessionId);
    const staffId = staffWith(PROGRAM_MANAGE, program.communeKey);
    const newStart = instant(input.newStart, 'newStart');
    return this.sessionAction(staffId, 'session.reschedule_ksp', input.idempotencyKey, program, session, {
      body: {
        newStart: newStart.toISOString(),
        reason: input.reason,
        durationMinutes: input.durationMinutes ?? null,
      },
      decide: async (ctx) => {
        const moved = rescheduleByKsp(ctx.session, {
          programStatus: ctx.program.status,
          programCauses: ctx.program.causes.map((cause) => cause.cause),
          programSessions: ctx.sessions,
          newStart,
          durationMinutes: input.durationMinutes ?? null,
          reason: input.reason,
          actorId: staffId,
          now: ctx.now,
        });
        if (ctx.session.status === 'interrupted') {
          await ctx.tx.decideIncidents(ctx.session.id, decided(ctx.session, 'rescheduled', staffId, ctx.now));
        }
        return applyReschedule(ctx, moved);
      },
    });
  }

  /** Partie 12 : annulation par KSP (rien à payer) ou annulation tardive du client (part due). */
  async cancelSession(input: {
    sessionId: string;
    idempotencyKey: string;
    initiatedBy: string;
    reason: string;
  }): Promise<StaffSessionDetails> {
    const { program, session } = await this.session(input.sessionId);
    const staffId = staffWith(PROGRAM_MANAGE, program.communeKey);
    if (input.initiatedBy !== 'ksp' && input.initiatedBy !== 'customer_late') {
      throw cleaningErrors.invalid('initiatedBy', 'invalid_type');
    }
    const initiatedBy = input.initiatedBy;
    return this.sessionAction(staffId, 'session.cancel_ksp', input.idempotencyKey, program, session, {
      body: { initiatedBy, reason: input.reason },
      decide: async (ctx) => {
        const cancelled = cancelSessionAsKsp(ctx.session, {
          initiatedBy,
          reason: input.reason,
          actorId: staffId,
          now: ctx.now,
          freeCancellationHours: ctx.settings.freeCancellationHours,
        });
        if (ctx.session.status === 'interrupted') {
          await ctx.tx.decideIncidents(ctx.session.id, decided(ctx.session, 'cancelled', staffId, ctx.now));
        }
        return applyCancellation(this.payments, ctx, cancelled, staffId);
      },
    });
  }

  /** Partie 10 : reprise d'une séance interrompue, décidée par le superviseur. */
  async resumeSession(input: {
    sessionId: string;
    idempotencyKey: string;
    reason?: string;
  }): Promise<StaffSessionDetails> {
    const { program, session } = await this.session(input.sessionId);
    const staffId = staffWith(PROGRAM_MANAGE, program.communeKey);
    return this.sessionAction(staffId, 'session.resume', input.idempotencyKey, program, session, {
      body: { reason: input.reason ?? null },
      decide: async (ctx) => {
        const next = resumeSession(ctx.session, { staffId, now: ctx.now });
        await ctx.tx.decideIncidents(ctx.session.id, next.incidents);
        return {
          patch: { status: 'in_progress' },
          effects: {
            events: [],
            audit: [
              audit(staffId, 'session.incident_decided', { type: 'session', id: ctx.session.id }, ctx.now, {
                decision: 'resumed',
              }),
            ],
          },
        };
      },
    });
  }

  /** R-EX-08 : réalisation enregistrée pour l'équipe ; paiement et facture comme une clôture. */
  async completeSession(input: {
    sessionId: string;
    idempotencyKey: string;
    reason: string;
    startedAt: string;
    completedAt: string;
    presentAgentIds: readonly string[];
    beforePhotoFileIds?: readonly string[];
    afterPhotoFileIds?: readonly string[];
  }): Promise<StaffSessionDetails> {
    const { program, session } = await this.session(input.sessionId);
    const staffId = staffWith(PROGRAM_MANAGE, program.communeKey);
    const startedAt = instant(input.startedAt, 'startedAt');
    const completedAt = instant(input.completedAt, 'completedAt');
    const { idempotencyKey: _key, sessionId: _id, ...body } = input;
    return this.sessionAction(staffId, 'session.complete_ksp', input.idempotencyKey, program, session, {
      body,
      decide: async (ctx) => {
        const { session: next } = completeSessionAsKsp(ctx.session, {
          staffId,
          reason: input.reason,
          startedAt,
          completedAt,
          presentAgentIds: input.presentAgentIds,
          beforePhotoFileIds: input.beforePhotoFileIds ?? [],
          afterPhotoFileIds: input.afterPhotoFileIds ?? [],
          now: ctx.now,
          arrivalMaxAdvanceMinutes: ctx.settings.arrivalMaxAdvanceMinutes,
        });
        if (ctx.session.status === 'interrupted') {
          await ctx.tx.decideIncidents(ctx.session.id, decided(ctx.session, 'resumed', staffId, ctx.now));
        }
        const closed = await closeSession(this.payments, ctx, next, { kind: 'completed' }, 'ksp', {
          status: 'completed',
          startedAt: next.startedAt,
          completedAt: next.completedAt,
          beforePhotoFileIds: next.beforePhotoFileIds,
          afterPhotoFileIds: next.afterPhotoFileIds,
          staffClosure: next.staffClosure!,
        });
        closed.effects.audit.push(
          audit(staffId, 'session.closed_by_ksp', { type: 'session', id: ctx.session.id }, ctx.now, {
            outcome: 'completed',
            presentAgentIds: next.staffClosure!.presentAgentIds,
          }),
        );
        return {
          patch: closed.patch,
          effects: closed.effects,
          collect: closed.collect ? [ctx.session.id] : [],
        };
      },
    });
  }

  /** R-EX-08 : absence du client (ou accès impossible) enregistrée pour l'équipe. */
  async reportSessionMissed(input: {
    sessionId: string;
    idempotencyKey: string;
    reason: string;
    cause: string;
    missedAt: string;
    presentAgentIds: readonly string[];
    photoFileId?: string | null;
    waitStartedAt?: string | null;
    calledAt?: string | null;
  }): Promise<StaffSessionDetails> {
    const { program, session } = await this.session(input.sessionId);
    const staffId = staffWith(PROGRAM_MANAGE, program.communeKey);
    if (input.cause !== 'customer_absent' && input.cause !== 'access_impossible') {
      throw cleaningErrors.invalid('cause', 'invalid_type');
    }
    const cause = input.cause as MissedCause;
    const missedAt = instant(input.missedAt, 'missedAt');
    const { idempotencyKey: _key, sessionId: _id, ...body } = input;
    return this.sessionAction(staffId, 'session.missed_ksp', input.idempotencyKey, program, session, {
      body,
      decide: async (ctx) => {
        const { session: next } = reportSessionMissedAsKsp(ctx.session, {
          staffId,
          reason: input.reason,
          cause,
          missedAt,
          presentAgentIds: input.presentAgentIds,
          photoFileId: input.photoFileId ? requireUuid(input.photoFileId, 'photoFileId') : null,
          waitStartedAt: optionalInstant(input.waitStartedAt, 'waitStartedAt'),
          calledAt: optionalInstant(input.calledAt, 'calledAt'),
          now: ctx.now,
        });
        const closed = await closeSession(this.payments, ctx, next, { kind: 'missed', cause }, 'ksp', {
          status: 'missed',
          missed: next.missed!,
          staffClosure: next.staffClosure!,
        });
        closed.effects.audit.push(
          audit(staffId, 'session.closed_by_ksp', { type: 'session', id: ctx.session.id }, ctx.now, {
            outcome: 'missed',
            cause,
            presentAgentIds: next.staffClosure!.presentAgentIds,
          }),
        );
        return {
          patch: closed.patch,
          effects: closed.effects,
          collect: closed.collect ? [ctx.session.id] : [],
        };
      },
    });
  }

  /**
   * R-EX-10 : retrait d'une photo par la supervision, à tout moment, avec un motif ; jamais pendant
   * une réclamation ouverte ; après la clôture, la dernière photo d'un type exige un remplacement.
   */
  async removePhoto(input: {
    sessionId: string;
    fileId: string;
    idempotencyKey: string;
    reason: string;
    replacementFileId?: string | null;
  }): Promise<StaffSessionDetails> {
    const { program, session } = await this.session(input.sessionId);
    const staffId = staffWith(PROGRAM_MANAGE, program.communeKey);
    const fileId = requireUuid(input.fileId, 'fileId');
    const replacement = input.replacementFileId
      ? requireUuid(input.replacementFileId, 'replacementFileId')
      : null;
    return this.sessionAction(staffId, 'session.photo_remove_ksp', input.idempotencyKey, program, session, {
      body: { fileId, reason: input.reason, replacementFileId: replacement },
      decide: async (ctx) => {
        const reason = requireReason(input.reason);
        if (ctx.session.openClaim)
          throw invalidTransition(ctx.session.status, ctx.session.status, 'claim_open');
        const kind = ctx.session.beforePhotoFileIds.includes(fileId)
          ? 'before'
          : ctx.session.afterPhotoFileIds.includes(fileId)
            ? 'after'
            : null;
        if (!kind) return { patch: {}, effects: { events: [], audit: [] } };
        const field = kind === 'before' ? 'beforePhotoFileIds' : 'afterPhotoFileIds';
        const remaining = ctx.session[field].filter((id) => id !== fileId);
        const closed = ctx.session.status === 'completed';
        if (closed && remaining.length === 0 && !replacement) {
          throw new ExecutionRuleError('CLEANING_PHOTOS_MISSING', { kind });
        }
        if (replacement) {
          await this.deps.photos.attach({
            fileId: replacement,
            subject: { type: 'cleaning_session', id: ctx.session.id },
            ownerId: staffId,
          });
        }
        await this.deps.photos.remove(fileId, { type: 'cleaning_session', id: ctx.session.id });
        return {
          patch: { [field]: replacement ? [...remaining, replacement] : remaining },
          effects: {
            events: [],
            audit: [
              audit(staffId, 'session.photo_removed', { type: 'session', id: ctx.session.id }, ctx.now, {
                fileId,
                kind,
                reason,
                ...(replacement ? { replacementFileId: replacement } : {}),
              }),
            ],
          },
        };
      },
    });
  }

  private async resumption(programId: string): Promise<ProgramResumptionView> {
    const program = await this.program(programId);
    const sessions = await this.deps.execution.programSessions(programId);
    const catchUp =
      program.status === 'suspended'
        ? []
        : sessions
            .filter((session: SessionRecord) => session.status === 'suspended')
            .map((session) => ({
              sessionId: session.id,
              rank: session.rank,
              previousStart: session.scheduledStart,
              suggestedStart: session.catchUpSuggestedStart,
            }));
    return { program, catchUp };
  }

  private sessionAction(
    staffId: string,
    operation: string,
    key: string,
    program: ProgramRecord,
    session: SessionRecord,
    action: { body: unknown; decide: Parameters<typeof executionAction>[2]['decide'] },
  ): Promise<StaffSessionDetails> {
    return executionAction(this.deps, this.payments, {
      actorId: staffId,
      operation,
      key,
      body: { sessionId: session.id, ...(action.body as object) },
      programId: program.id,
      sessionId: session.id,
      view: () => this.getSession(session.id),
      decide: action.decide,
    });
  }

  private async program(programId: string): Promise<ProgramRecord> {
    requireStaff();
    const program = await this.deps.execution.program(requireUuid(programId, 'programId'));
    if (!program) throw executionErrors.programNotFound();
    return program;
  }

  private async session(sessionId: string): Promise<{ program: ProgramRecord; session: SessionRecord }> {
    requireStaff();
    const session = await this.deps.execution.session(requireUuid(sessionId, 'sessionId'));
    const program = session ? await this.deps.execution.program(session.programId) : null;
    if (!session || !program) throw executionErrors.sessionNotFound();
    return { program, session };
  }
}

/** Décision du superviseur posée sur l'incident en attente. */
function decided(
  session: SessionRecord,
  decision: 'resumed' | 'cancelled' | 'rescheduled',
  staffId: string,
  now: Date,
) {
  return session.incidents.map((incident) =>
    incident.decision === 'pending'
      ? { ...incident, decision, decidedBy: staffId, decidedAt: now }
      : incident,
  );
}
