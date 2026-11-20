import { type SessionOutcome } from '../../domain/payments/charge';
import { type StartPaymentContext } from '../../domain/payments/start-gate';
import { expectedSessionAmount } from '../../domain/payments/charge';
import { arrivalPosition } from '../../domain/sessions/arrival';
import { invalidTransition, validationFailed } from '../../domain/sessions/errors';
import { completeSession, reportCustomerAbsent, reportIncident } from '../../domain/sessions/field-outcomes';
import {
  addSessionPhoto,
  arriveAtSession,
  startSession,
  updateChecklist,
} from '../../domain/sessions/field-steps';
import {
  assertTeamMember,
  type FieldSession,
  type IncidentCategory,
  type MissedCause,
} from '../../domain/sessions/session';
import { type ExecutionDeps } from '../deps';
import { type OutboxMessage } from '../ports';
import { requireConnectedUser } from '../shared/access';
import { type IdempotencyStub, runIdempotent } from '../shared/idempotency';
import { optionalInstant, requireUuid } from '../shared/input';
import { executionError, executionErrors } from './execution-errors';
import {
  type ExecutionSettings,
  type ExecutionTx,
  type ProgramRecord,
  type SessionPatch,
  type SessionRecord,
} from './execution.ports';
import {
  applyProgress,
  audit,
  type Effects,
  holderOf,
  lockedProgram,
  merge,
  noEffects,
  sessionFields,
  xof,
} from './execution-support';
import { SessionPayments } from './session-payments';
import {
  type ArrivalBlob,
  arrivalGpsContext,
  checklistFor,
  type SessionDetails,
  sessionDetails,
} from './session-views';

/**
 * Application agent, séance sur le terrain (UC-NT-23, UC-NT-24, partie 10) : arrivée, photos,
 * démarrage, liste de contrôle, incident, clôture, client absent, retrait d'une photo. Seuls les
 * agents affectés voient la séance (R-EX-01) ; chaque action est rejouable hors connexion avec sa
 * clé d'idempotence et son heure réelle (R-EX-05).
 */

interface Decision {
  patch: SessionPatch;
  effects: Effects;
  /** Séance close à débiter après la transaction (UC-NT-46). */
  collect?: boolean;
}

interface Context {
  tx: ExecutionTx;
  program: ProgramRecord;
  sessions: SessionRecord[];
  session: SessionRecord;
  settings: ExecutionSettings;
  agentId: string;
  userId: string;
  now: Date;
}

const INCIDENT_CATEGORIES: readonly IncidentCategory[] = [
  'equipment',
  'access',
  'safety',
  'out_of_scope_request',
  'other',
];

export class FieldSessionUseCases {
  private readonly payments: SessionPayments;

  constructor(private readonly deps: ExecutionDeps) {
    this.payments = new SessionPayments(deps);
  }

  /** Séance vue par un agent affecté ; un agent désaffecté ne la voit plus (R-EX-06). */
  async get(sessionId: string): Promise<SessionDetails & { agentId: string }> {
    const userId = requireConnectedUser();
    const agentId = await this.agentId(userId);
    const session = await this.memberSession(sessionId, agentId);
    return { ...(await sessionDetails(this.deps, session, { forAgent: true })), agentId };
  }

  arrive(input: {
    sessionId: string;
    idempotencyKey: string;
    latitude?: number | null;
    longitude?: number | null;
    accuracyMeters?: number | null;
    occurredAt?: string | null;
  }) {
    return this.act('session.arrive', input, async (ctx) => {
      const position = arrivalPosition(input);
      const points = await this.deps.placePoints.points([ctx.program.placeId]);
      const place = points.get(ctx.program.placeId) ?? null;
      const before = ctx.session.arrivedAt;
      const next = arriveAtSession(ctx.session, {
        agentId: ctx.agentId,
        now: ctx.now,
        occurredAt: optionalInstant(input.occurredAt, 'occurredAt'),
        position,
        place,
        settings: ctx.settings,
      });
      if (before || !next.arrivedAt || !next.arrival) return { patch: {}, effects: noEffects() };
      const blob: ArrivalBlob | null = position
        ? { position: { ...position, accuracyMeters: position.accuracyMeters ?? null }, check: next.arrival }
        : null;
      return {
        patch: {
          arrivedAt: next.arrivedAt,
          arrivalDistanceM: next.arrival.distanceMeters,
          arrivalGpsEncrypted: blob
            ? this.deps.cipher.encrypt(JSON.stringify(blob), arrivalGpsContext(ctx.session.id))
            : null,
        },
        effects: {
          events: [
            {
              type: 'cleaning.session.arrived',
              payload: {
                ...sessionFields(ctx.program, ctx.session),
                communeKey: ctx.program.communeKey,
                distanceMeters: next.arrival.distanceMeters,
                alert: next.arrival.alert,
                arrivedAt: next.arrivedAt.toISOString(),
              },
            },
          ],
          audit: [],
        },
      };
    });
  }

  addPhoto(input: {
    sessionId: string;
    idempotencyKey: string;
    fileId: string;
    kind: string;
    occurredAt?: string | null;
  }) {
    return this.act('session.photo_add', input, async (ctx) => {
      if (input.kind !== 'before' && input.kind !== 'after') throw executionError(validation('kind'));
      const fileId = requireUuid(input.fileId, 'fileId');
      const next = addSessionPhoto(ctx.session, {
        agentId: ctx.agentId,
        kind: input.kind,
        fileId,
        now: ctx.now,
        occurredAt: optionalInstant(input.occurredAt, 'occurredAt'),
        maxPerKind: ctx.settings.maxPhotosPerType,
      });
      if (next === ctx.session) return { patch: {}, effects: noEffects() };
      // Rattachée chez file au nom de l'agent avant que sa référence ne soit enregistrée (RV-102).
      await this.deps.photos.attach({
        fileId,
        subject: { type: 'cleaning_session', id: ctx.session.id },
        ownerId: ctx.userId,
      });
      return {
        patch: { beforePhotoFileIds: next.beforePhotoFileIds, afterPhotoFileIds: next.afterPhotoFileIds },
        effects: noEffects(),
      };
    });
  }

  /** R-EX-10 : l'agent affecté retire une photo tant que la séance n'est ni réalisée ni annulée. */
  removePhoto(input: { sessionId: string; idempotencyKey: string; fileId: string }) {
    return this.act('session.photo_remove', input, async (ctx) => {
      assertTeamMember(ctx.session, ctx.agentId, false);
      if (['completed', 'cancelled', 'missed'].includes(ctx.session.status)) {
        throw invalidTransition(ctx.session.status, ctx.session.status);
      }
      const fileId = requireUuid(input.fileId, 'fileId');
      const before = ctx.session.beforePhotoFileIds.filter((id) => id !== fileId);
      const after = ctx.session.afterPhotoFileIds.filter((id) => id !== fileId);
      if (
        before.length === ctx.session.beforePhotoFileIds.length &&
        after.length === ctx.session.afterPhotoFileIds.length
      ) {
        return { patch: {}, effects: noEffects() };
      }
      await this.deps.photos.remove(fileId, { type: 'cleaning_session', id: ctx.session.id });
      return {
        patch: { beforePhotoFileIds: before, afterPhotoFileIds: after },
        effects: {
          events: [],
          audit: [
            audit(ctx.userId, 'session.photo_removed', { type: 'session', id: ctx.session.id }, ctx.now, {
              fileId,
            }),
          ],
        },
      };
    });
  }

  start(input: { sessionId: string; idempotencyKey: string; occurredAt?: string | null }) {
    return this.act('session.start', input, async (ctx) => {
      const checklist = checklistFor(ctx.session, ctx.program, ctx.settings);
      const next = startSession(
        { ...ctx.session, checklist },
        {
          agentId: ctx.agentId,
          now: ctx.now,
          occurredAt: optionalInstant(input.occurredAt, 'occurredAt'),
          payment: await this.startPayment(ctx),
        },
      );
      const sessions = ctx.sessions.map((line) =>
        line.id === next.id ? { ...line, status: next.status } : line,
      );
      const progress = await applyProgress(ctx.tx, ctx.program, sessions, ctx.now);
      const lead = ctx.session.agents.find((agent) => agent.isLead)?.agentId ?? ctx.agentId;
      return {
        patch: { status: 'in_progress', startedAt: next.startedAt, checklist },
        effects: merge(progress, {
          events: [
            {
              type: 'cleaning.session.started',
              payload: {
                ...sessionFields(ctx.program, ctx.session),
                leadAgentId: lead,
                startedAt: next.startedAt!.toISOString(),
              },
            },
          ],
          audit: [],
        }),
      };
    });
  }

  updateChecklist(input: {
    sessionId: string;
    idempotencyKey: string;
    items: readonly { code: string; checked: boolean; cleaningTypeCode?: string | null }[];
    occurredAt?: string | null;
  }) {
    return this.act('session.checklist', input, async (ctx) => {
      const next = updateChecklist(
        { ...ctx.session, checklist: checklistFor(ctx.session, ctx.program, ctx.settings) },
        {
          agentId: ctx.agentId,
          now: ctx.now,
          occurredAt: optionalInstant(input.occurredAt, 'occurredAt'),
          items: input.items.map((item) => ({
            code: item.code,
            checked: item.checked,
            cleaningTypeCode: item.cleaningTypeCode || null,
          })),
        },
      );
      return { patch: { checklist: next.checklist }, effects: noEffects() };
    });
  }

  reportIncident(input: {
    sessionId: string;
    idempotencyKey: string;
    category: string;
    note: string;
    photoFileIds: readonly string[];
    occurredAt?: string | null;
  }) {
    return this.act('session.incident', input, async (ctx) => {
      if (!INCIDENT_CATEGORIES.includes(input.category as IncidentCategory)) {
        throw executionError(validation('category'));
      }
      const photoFileIds = input.photoFileIds.map((id, index) => requireUuid(id, `photoFileIds[${index}]`));
      const { session: next } = reportIncident(ctx.session, {
        agentId: ctx.agentId,
        incidentId: this.deps.ids.next(),
        category: input.category as IncidentCategory,
        note: input.note,
        photoFileIds,
        now: ctx.now,
        occurredAt: optionalInstant(input.occurredAt, 'occurredAt'),
        maxPhotos: ctx.settings.maxPhotosPerType,
      });
      const incident = next.incidents.at(-1)!;
      for (const fileId of incident.photoFileIds) {
        await this.deps.photos.attach({
          fileId,
          subject: { type: 'cleaning_session', id: ctx.session.id },
          ownerId: ctx.userId,
        });
      }
      await ctx.tx.insertIncident(ctx.session.id, incident);
      return {
        patch: { status: 'interrupted' },
        effects: {
          events: [
            {
              type: 'cleaning.session.interrupted',
              payload: {
                ...sessionFields(ctx.program, ctx.session),
                communeKey: ctx.program.communeKey,
                incidentId: incident.id,
                category: incident.category,
                interruptedAt: incident.occurredAt.toISOString(),
              },
            },
          ],
          audit: [],
        },
      };
    });
  }

  complete(input: {
    sessionId: string;
    idempotencyKey: string;
    signatureFileId?: string | null;
    occurredAt?: string | null;
  }) {
    return this.act('session.complete', input, async (ctx) => {
      const signatureFileId = input.signatureFileId
        ? requireUuid(input.signatureFileId, 'signatureFileId')
        : null;
      const next = completeSession(
        { ...ctx.session, checklist: checklistFor(ctx.session, ctx.program, ctx.settings) },
        {
          agentId: ctx.agentId,
          now: ctx.now,
          occurredAt: optionalInstant(input.occurredAt, 'occurredAt'),
          signatureFileId,
        },
      );
      return closeSession(this.payments, ctx, next, { kind: 'completed' }, 'team', {
        status: 'completed',
        completedAt: next.completedAt,
        signatureFileId: next.signatureFileId,
      });
    });
  }

  reportMissed(input: {
    sessionId: string;
    idempotencyKey: string;
    cause: string;
    photoFileId: string;
    waitStartedAt: string;
    calledAt: string;
    occurredAt?: string | null;
  }) {
    return this.act('session.missed', input, async (ctx) => {
      if (input.cause !== 'customer_absent' && input.cause !== 'access_impossible') {
        throw executionError(validation('cause'));
      }
      const photoFileId = requireUuid(input.photoFileId, 'photoFileId');
      const next = reportCustomerAbsent(ctx.session, {
        agentId: ctx.agentId,
        now: ctx.now,
        occurredAt: optionalInstant(input.occurredAt, 'occurredAt'),
        cause: input.cause as MissedCause,
        photoFileId,
        waitStartedAt: optionalInstant(input.waitStartedAt, 'waitStartedAt') ?? missing('waitStartedAt'),
        calledAt: optionalInstant(input.calledAt, 'calledAt') ?? missing('calledAt'),
        waitMinutes: ctx.settings.customerWaitMinutes,
      });
      await this.deps.photos.attach({
        fileId: photoFileId,
        subject: { type: 'cleaning_session', id: ctx.session.id },
        ownerId: ctx.userId,
      });
      return closeSession(this.payments, ctx, next, { kind: 'missed', cause: next.missed!.cause }, 'team', {
        status: 'missed',
        missed: next.missed!,
      });
    });
  }

  /** Paiement exigé au démarrage (R-PP-04, R-PP-05) ; null pour une entreprise. */
  private async startPayment(ctx: Context): Promise<StartPaymentContext | null> {
    if (ctx.program.payerKind !== 'individual') return null;
    const expectedAmount = expectedSessionAmount(ctx.session.price, ctx.program.visitFeeToDeduct);
    const balance = ctx.settings.balanceGuarantee
      ? await this.deps.balances.balance(holderOf(ctx.program))
      : expectedAmount;
    return {
      payerKind: 'individual',
      programSessions: ctx.sessions.map((line) => ({
        sessionId: line.id,
        paymentStatus: line.paymentStatus,
        dueBy: line.dueBy,
      })),
      balanceGuarantee: ctx.settings.balanceGuarantee,
      balance,
      expectedAmount,
    };
  }

  private async agentId(userId: string): Promise<string> {
    const agent = await this.deps.planning.agentByUserId(userId);
    if (!agent) throw executionErrors.sessionNotFound();
    return agent.id;
  }

  private async memberSession(sessionId: string, agentId: string): Promise<SessionRecord> {
    const session = await this.deps.execution.session(requireUuid(sessionId, 'sessionId'));
    if (!session || !session.agents.some((agent) => agent.agentId === agentId)) {
      throw executionErrors.sessionNotFound();
    }
    return session;
  }

  /**
   * Action de terrain : séance verrouillée avec son programme, décision du domaine, écriture de
   * l'état, des événements et de la clé dans une transaction ; débit d'une séance close ensuite.
   */
  private async act(
    operation: string,
    input: { sessionId: string; idempotencyKey: string },
    decide: (ctx: Context) => Promise<Decision>,
  ): Promise<SessionDetails & { agentId: string }> {
    const userId = requireConnectedUser();
    const agentId = await this.agentId(userId);
    const sessionId = requireUuid(input.sessionId, 'sessionId');
    const { idempotencyKey, ...body } = input;
    const view = () => this.get(sessionId);
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: userId,
      operation,
      key: idempotencyKey,
      body,
      at: this.deps.clock.now(),
      replay: view,
      run: async (stub: IdempotencyStub) => {
        const session = await this.memberSession(sessionId, agentId);
        let collect = false;
        try {
          await this.deps.execution.transaction(async (tx) => {
            const { program, sessions } = await lockedProgram(tx, session.programId);
            const current = sessions.find((line) => line.id === sessionId)!;
            const settings = await tx.settings();
            const now = this.deps.clock.now();
            const decision = await decide({
              tx,
              program,
              sessions,
              session: current,
              settings,
              agentId,
              userId,
              now,
            });
            if (Object.keys(decision.patch).length > 0) {
              await tx.updateSession(sessionId, current.version, decision.patch);
            }
            await tx.write({ ...decision.effects, idempotency: stub({ sessionId }) });
            collect = decision.collect ?? false;
          });
        } catch (error) {
          throw executionError(error);
        }
        if (collect) await this.payments.collect(sessionId, 'close');
        return view();
      },
    });
  }
}

const validation = (field: string) => validationFailed(field, 'invalid_type');

function missing(field: string): never {
  throw executionError(validationFailed(field, 'required'));
}

/**
 * Clôture d'une séance (réalisée ou manquée) : charge (montant dû, frais de visite déduits),
 * événement cleaning.session.completed / missed avec le montant dû (billing, facture mensuelle des
 * entreprises), progression du programme ; le débit suit la transaction.
 */
export async function closeSession(
  payments: SessionPayments,
  ctx: {
    tx: ExecutionTx;
    program: ProgramRecord;
    sessions: SessionRecord[];
    session: SessionRecord;
    settings: ExecutionSettings;
    now: Date;
  },
  next: FieldSession,
  outcome: SessionOutcome,
  by: 'team' | 'ksp',
  statePatch: SessionPatch,
): Promise<Decision> {
  const { charge, patch } = await payments.chargeOnClose(
    ctx.tx,
    ctx.program,
    ctx.session,
    outcome,
    ctx.settings,
    ctx.now,
  );
  const sessions = ctx.sessions.map((line) =>
    line.id === next.id ? { ...line, status: next.status } : line,
  );
  const progress = await applyProgress(ctx.tx, ctx.program, sessions, ctx.now);
  const common = {
    ...sessionFields(ctx.program, ctx.session),
    payerKind: ctx.program.payerKind,
    placeId: ctx.program.placeId,
    scheduledStart: ctx.session.scheduledStart.toISOString(),
    price: xof(ctx.session.price),
    visitFeeDeduction: xof(charge.visitFeeDeduction),
    amountDue: xof(charge.amountDue),
  };
  const event: OutboxMessage =
    outcome.kind === 'completed'
      ? {
          type: 'cleaning.session.completed',
          payload: { ...common, completedAt: next.completedAt!.toISOString(), completedBy: by },
        }
      : {
          type: 'cleaning.session.missed',
          payload: {
            ...common,
            cause: outcome.kind === 'missed' ? outcome.cause : 'late_cancellation',
            feeBps: charge.amountDue === 0 ? 0 : ctx.settings.lateCancellationFeePct * 100,
            missedAt: (next.missed?.missedAt ?? ctx.now).toISOString(),
            communeKey: ctx.program.communeKey,
            reportedBy: by,
          },
        };
  return {
    patch: { ...statePatch, ...patch },
    effects: merge(progress, { events: [event], audit: [] }),
    collect: charge.paymentStatus === 'due',
  };
}
