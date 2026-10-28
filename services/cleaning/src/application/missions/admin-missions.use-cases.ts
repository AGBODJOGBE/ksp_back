import { DEFAULT_CHECKLIST } from '../../domain/catalog';
import {
  canTransitionIntervention,
  deriveMissionStatus,
  type Intervention,
  type InterventionStatus,
  isAssignedAgent,
  isChecklistComplete,
  isTerminalMission,
  type Mission,
  type MissionStatus,
  remainingToSchedule,
} from '../../domain/mission';
import {
  type PaymentMethod,
  paymentRefusal,
  type PaymentRecord,
  paymentWithKey,
  remainingDue,
} from '../../domain/payment';
import { conflictingAgents, isBeforeScheduledDay, slotFrom } from '../../domain/schedule';
import { type CleaningDeps, missionView, type MissionView } from '../deps';
import { type Changes, type OutboxMessage } from '../ports';
import { FIELD_WORK, requireStaff, seesEverything, type Staff, SUPERVISION } from '../shared/access';
import { CleaningErrors } from '../shared/errors';
import {
  optionalText,
  type PageRequest,
  type PageResult,
  parseDate,
  requiredText,
  requirePositiveInt,
  requireUuid,
} from '../shared/validation';
import { isBusinessContract } from '../../domain/standing';
import { EvaluateStandingUseCase } from '../standing/standing.use-cases';
import { cancelled, saveMission } from './customer-missions.use-cases';

const MISSION_STATUSES: readonly MissionStatus[] = [
  'to_schedule',
  'scheduled',
  'in_progress',
  'on_hold',
  'completed',
  'cancelled',
];

/** Mission visible par ce membre du back-office : tout pour la supervision, ses passages pour un agent. */
async function visibleMission(deps: CleaningDeps, staff: Staff, missionId: string): Promise<Mission> {
  const mission = await deps.missions.findById(missionId);
  if (!mission || (!seesEverything(staff) && !isAssignedAgent(mission, staff.userId))) {
    throw CleaningErrors.missionNotFound();
  }
  return mission;
}

/** UC-CL-09, 10 : missions (supervision : toutes ; agent : celles où il est affecté). */
export class ListMissionsUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { page: PageRequest; status: string }): Promise<PageResult<MissionView>> {
    const staff = requireStaff(FIELD_WORK);
    if (input.status && !MISSION_STATUSES.includes(input.status as MissionStatus)) {
      throw CleaningErrors.invalid('status');
    }
    const result = await this.deps.missions.list(
      {
        ...(input.status ? { status: input.status as MissionStatus } : {}),
        ...(seesEverything(staff) ? {} : { agentId: staff.userId }),
      },
      input.page,
    );
    return {
      items: await Promise.all(result.items.map((mission) => missionView(this.deps, mission))),
      nextCursor: result.nextCursor,
    };
  }
}

export class GetMissionDetailUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(missionId: string): Promise<MissionView> {
    const staff = requireStaff(FIELD_WORK);
    return missionView(this.deps, await visibleMission(this.deps, staff, missionId));
  }
}

export interface ScheduleInterventionInput {
  missionId: string;
  scheduledStart: string;
  durationMinutes: number;
  agentIds: string[];
  teamId: string;
}

/**
 * UC-CL-09 : planifier un passage avec ses agents (équipe et/ou agents choisis). Refus si un
 * agent est déjà pris sur le créneau (CLEANING_TEAM_UNAVAILABLE).
 */
export class ScheduleInterventionUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: ScheduleInterventionInput): Promise<MissionView> {
    const staff = requireStaff(SUPERVISION);
    const mission = await visibleMission(this.deps, staff, input.missionId);
    const now = this.deps.clock.now();
    if (isTerminalMission(mission.status))
      throw CleaningErrors.invalidTransition(mission.status, 'scheduled');
    if (mission.suspension) throw CleaningErrors.contractSuspended();
    if (remainingToSchedule(mission) === 0) throw CleaningErrors.noInterventionLeft();
    const start = parseDate('scheduledStart', input.scheduledStart);
    if (start <= now) throw CleaningErrors.slotInvalid('Le passage doit être planifié dans le futur.');
    const durationMinutes = requirePositiveInt('durationMinutes', input.durationMinutes, 24 * 60);

    const agentIds = input.agentIds.map((id, index) => requireUuid(`agentIds[${index}]`, id));
    if (input.teamId) {
      const team = await this.deps.agents.findTeam(requireUuid('teamId', input.teamId));
      if (!team) throw CleaningErrors.teamNotFound();
      agentIds.push(...team.memberIds);
    }
    const unique = [...new Set(agentIds)];
    if (!unique.length) throw CleaningErrors.invalid('agentIds', 'Affectez au moins un agent.');
    const agents = await this.deps.agents.findAgents(unique);
    const missing = unique.filter((id) => !agents.some((agent) => agent.agentId === id && agent.active));
    if (missing.length) throw CleaningErrors.agentNotFound(missing);

    const service = await this.deps.catalog.findService(mission.serviceCode);
    const template = service?.pricing.checklist.length ? service.pricing.checklist : DEFAULT_CHECKLIST;
    const intervention: Intervention = {
      id: this.deps.ids.next(),
      status: 'planned',
      scheduledStart: start,
      durationMinutes,
      agentIds: unique,
      checklist: template.map((item) => ({ ...item, done: false })),
      incidentNote: null,
      beforePhotoFileIds: [],
      afterPhotoFileIds: [],
      startedAt: null,
      completedAt: null,
      cancellationCause: null,
      cancelledAt: null,
    };
    const updated: Mission = {
      ...mission,
      interventions: [...mission.interventions, intervention],
      updatedAt: now,
    };
    updated.status = deriveMissionStatus(updated);

    const slot = slotFrom(start, durationMinutes);
    const result = await this.deps.missions.scheduleIntervention(
      updated,
      intervention,
      (busy) => conflictingAgents(unique, slot, busy),
      {
        events: [
          {
            type: 'cleaning.mission.scheduled',
            payload: {
              missionId: mission.id,
              interventionId: intervention.id,
              customerId: mission.customerId,
              scheduledStart: start.toISOString(),
              durationMinutes,
              agentIds: unique,
            },
          },
        ],
        audit: [
          {
            actorId: staff.userId,
            action: 'intervention.scheduled',
            entityType: 'mission',
            entityId: mission.id,
            at: now,
            details: {
              interventionId: intervention.id,
              agentIds: unique,
              scheduledStart: start.toISOString(),
            },
          },
        ],
      },
    );
    if (result.conflicts.length) throw CleaningErrors.teamUnavailable(result.conflicts);
    if (!result.saved) throw CleaningErrors.concurrentUpdate();
    return missionView(this.deps, { ...updated, version: updated.version + 1 });
  }
}

/** Action d'un agent (ou de la supervision) sur un passage : transition contrôlée, mission recalculée. */
abstract class InterventionAction {
  constructor(protected readonly deps: CleaningDeps) {}

  protected async apply(
    interventionId: string,
    to: InterventionStatus | null,
    change: (intervention: Intervention, now: Date) => Intervention,
    action: string,
  ): Promise<MissionView> {
    const staff = requireStaff(FIELD_WORK);
    const mission = await this.deps.missions.findByInterventionId(
      requireUuid('interventionId', interventionId),
    );
    const current = mission?.interventions.find((intervention) => intervention.id === interventionId);
    if (!mission || !current || (!seesEverything(staff) && !current.agentIds.includes(staff.userId))) {
      throw CleaningErrors.interventionNotFound();
    }
    if (mission.status === 'cancelled')
      throw CleaningErrors.invalidTransition(mission.status, to ?? current.status);
    if (to && !canTransitionIntervention(current.status, to))
      throw CleaningErrors.invalidTransition(current.status, to);
    if (!to && current.status !== 'in_progress')
      throw CleaningErrors.invalidTransition(current.status, current.status);

    const now = this.deps.clock.now();
    const next = { ...change(current, now), ...(to ? { status: to } : {}) };
    const updated: Mission = {
      ...mission,
      interventions: mission.interventions.map((intervention) =>
        intervention.id === current.id ? next : intervention,
      ),
    };
    updated.status = deriveMissionStatus(updated);
    const events: OutboxMessage[] = [];
    if (updated.status === 'completed' && mission.status !== 'completed') {
      events.push({
        type: 'cleaning.mission.completed',
        payload: {
          missionId: mission.id,
          customerId: mission.customerId,
          completedInterventions: updated.interventions.filter((i) => i.status === 'completed').length,
          completedAt: now.toISOString(),
        },
      });
    }
    return saveMission(this.deps, updated, {
      events,
      audit: [
        {
          actorId: staff.userId,
          action,
          entityType: 'mission',
          entityId: mission.id,
          at: now,
          details: { interventionId },
        },
      ],
    });
  }
}

/**
 * UC-CL-10 : démarrer un passage. Refusé avant le jour prévu, dans le fuseau du service
 * (CLEANING_INTERVENTION_TOO_EARLY) ; le jour même, à toute heure, il est permis. Règle
 * désactivable par configuration (à valider).
 */
export class StartInterventionUseCase extends InterventionAction {
  execute(interventionId: string): Promise<MissionView> {
    const { blockEarlyInterventionStart, timeZone } = this.deps.fieldDates;
    return this.apply(
      interventionId,
      'in_progress',
      (i, now) => {
        if (blockEarlyInterventionStart && isBeforeScheduledDay(now, i.scheduledStart, timeZone)) {
          throw CleaningErrors.interventionTooEarly(i.scheduledStart, timeZone);
        }
        return { ...i, startedAt: i.startedAt ?? now };
      },
      'intervention.started',
    );
  }
}

/** UC-CL-10 : cocher la liste de contrôle (les codes absents sont décochés). */
export class UpdateChecklistUseCase extends InterventionAction {
  execute(input: { interventionId: string; doneCodes: string[] }): Promise<MissionView> {
    return this.apply(
      input.interventionId,
      null,
      (i) => {
        const codes = new Set(input.doneCodes);
        if ([...codes].some((code) => !i.checklist.some((item) => item.code === code))) {
          throw CleaningErrors.invalid('doneCodes');
        }
        return { ...i, checklist: i.checklist.map((item) => ({ ...item, done: codes.has(item.code) })) };
      },
      'intervention.checklist_updated',
    );
  }
}

/** UC-CL-10 : signaler un incident, le passage est mis en attente. */
export class ReportIncidentUseCase extends InterventionAction {
  execute(input: { interventionId: string; note: string }): Promise<MissionView> {
    const note = requiredText('note', input.note, 2000);
    return this.apply(
      input.interventionId,
      'on_hold',
      (i) => ({ ...i, incidentNote: note }),
      'intervention.incident',
    );
  }
}

/** Reprise d'un passage en attente. */
export class ResumeInterventionUseCase extends InterventionAction {
  execute(interventionId: string): Promise<MissionView> {
    return this.apply(interventionId, 'in_progress', (i) => i, 'intervention.resumed');
  }
}

/** UC-CL-10 : clôturer un passage (liste de contrôle complète) ; la mission se termine au dernier. */
export class CompleteInterventionUseCase extends InterventionAction {
  execute(interventionId: string): Promise<MissionView> {
    return this.apply(
      interventionId,
      'completed',
      (i, now) => {
        if (!isChecklistComplete(i)) throw CleaningErrors.checklistIncomplete();
        return { ...i, completedAt: now };
      },
      'intervention.completed',
    );
  }
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

/**
 * Paiement manuel coché par le superviseur : espèces ou Mobile Money hors ligne. Pour un
 * particulier en récurrent, la régularisation peut débloquer la mission (partie 10).
 *
 * Idempotent par clé (en-tête Idempotency-Key, facultatif) : un second envoi avec la même clé
 * pour la même mission renvoie la mission telle quelle, sans second paiement ni nouveau
 * contrôle du reste dû. Deux envois simultanés : le contrôle de version n'en laisse passer
 * qu'un, l'autre relit la mission et rejoue.
 */
export class RecordPaymentUseCase {
  private readonly evaluate: EvaluateStandingUseCase;

  constructor(private readonly deps: CleaningDeps) {
    this.evaluate = new EvaluateStandingUseCase(deps);
  }

  async execute(input: {
    missionId: string;
    amount: number;
    method: string;
    reference: string;
    idempotencyKey?: string;
  }): Promise<MissionView> {
    const staff = requireStaff(SUPERVISION);
    const key = input.idempotencyKey ?? '';
    if (key && !IDEMPOTENCY_KEY.test(key)) {
      throw CleaningErrors.invalid('idempotencyKey', 'Clé d’idempotence invalide (8 à 100 caractères).');
    }
    const mission = await visibleMission(this.deps, staff, input.missionId);
    if (key && paymentWithKey(mission.payment, key)) return missionView(this.deps, mission);
    if (mission.status === 'cancelled') throw CleaningErrors.invalidTransition(mission.status, 'paid');
    // Une mission d'entreprise se règle par ses factures mensuelles (service billing).
    if (isBusinessContract(mission)) throw CleaningErrors.paymentViaInvoice();
    const method = input.method as PaymentMethod;
    const refusal = paymentRefusal(mission.payment, input.amount, method, true);
    if (refusal === 'exceeds_balance')
      throw CleaningErrors.paymentExceedsBalance(remainingDue(mission.payment));
    if (refusal) throw CleaningErrors.paymentInvalid(refusal);
    const now = this.deps.clock.now();
    const record: PaymentRecord = {
      id: this.deps.ids.next(),
      amount: input.amount,
      method,
      reference: optionalText('reference', input.reference, 100),
      recordedBy: staff.userId,
      recordedAt: now,
      idempotencyKey: key || null,
    };
    const payment = { ...mission.payment, payments: [...mission.payment.payments, record] };
    const view = await this.save({ ...mission, payment }, key, {
      events: [],
      audit: [
        {
          actorId: staff.userId,
          action: 'payment.recorded',
          entityType: 'mission',
          entityId: mission.id,
          at: now,
          details: { paymentId: record.id, amount: record.amount, method },
        },
      ],
    });
    if (!view.recorded || !mission.suspension) return view.view;
    if ((await this.evaluate.execute(mission.id)) !== 'resumed') return view.view;
    const resumed = await this.deps.missions.findById(mission.id);
    return resumed ? missionView(this.deps, resumed) : view.view;
  }

  /** Enregistre ; en cas d'écriture concurrente, un envoi déjà enregistré avec la même clé est rejoué. */
  private async save(
    mission: Mission,
    key: string,
    changes: Changes,
  ): Promise<{ view: MissionView; recorded: boolean }> {
    try {
      return { view: await saveMission(this.deps, mission, changes), recorded: true };
    } catch (error) {
      if (!key) throw error;
      const current = await this.deps.missions.findById(mission.id);
      if (!current || !paymentWithKey(current.payment, key)) throw error;
      return { view: await missionView(this.deps, current), recorded: false };
    }
  }
}

/** Annulation d'une mission par la supervision (motif obligatoire), y compris hors délai. */
export class CancelMissionAsSupervisorUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { missionId: string; reason: string }): Promise<MissionView> {
    const staff = requireStaff(SUPERVISION);
    const mission = await visibleMission(this.deps, staff, input.missionId);
    if (isTerminalMission(mission.status))
      throw CleaningErrors.invalidTransition(mission.status, 'cancelled');
    const reason = requiredText('reason', input.reason, 500);
    const now = this.deps.clock.now();
    return saveMission(this.deps, cancelled(mission, reason, now), {
      events: [
        {
          type: 'cleaning.request.cancelled',
          payload: {
            requestId: mission.requestId,
            missionId: mission.id,
            customerId: mission.customerId,
            cancelledBy: 'supervisor',
            outcome: 'cancelled',
          },
        },
      ],
      audit: [
        {
          actorId: staff.userId,
          action: 'mission.cancelled',
          entityType: 'mission',
          entityId: mission.id,
          at: now,
        },
      ],
    });
  }
}
