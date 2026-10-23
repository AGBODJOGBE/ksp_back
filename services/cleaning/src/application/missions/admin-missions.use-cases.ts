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
import { type PaymentMethod, paymentRefusal } from '../../domain/payment';
import { conflictingAgents, slotFrom } from '../../domain/schedule';
import { type CleaningDeps, missionView, type MissionView } from '../deps';
import { type OutboxMessage } from '../ports';
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

/** UC-CL-10 : démarrer un passage. */
export class StartInterventionUseCase extends InterventionAction {
  execute(interventionId: string): Promise<MissionView> {
    return this.apply(
      interventionId,
      'in_progress',
      (i, now) => ({ ...i, startedAt: i.startedAt ?? now }),
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

/** Paiement manuel coché par le superviseur : espèces ou Mobile Money hors ligne. */
export class RecordPaymentUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: {
    missionId: string;
    amount: number;
    method: string;
    reference: string;
  }): Promise<MissionView> {
    const staff = requireStaff(SUPERVISION);
    const mission = await visibleMission(this.deps, staff, input.missionId);
    if (mission.status === 'cancelled') throw CleaningErrors.invalidTransition(mission.status, 'paid');
    const method = input.method as PaymentMethod;
    const refusal = paymentRefusal(mission.payment, input.amount, method, true);
    if (refusal) throw CleaningErrors.paymentInvalid(refusal);
    const now = this.deps.clock.now();
    const record = {
      id: this.deps.ids.next(),
      amount: input.amount,
      method,
      reference: optionalText('reference', input.reference, 100),
      recordedBy: staff.userId,
      recordedAt: now,
    };
    const payment = { ...mission.payment, payments: [...mission.payment.payments, record] };
    return saveMission(
      this.deps,
      { ...mission, payment },
      {
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
      },
    );
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
    return saveMission(this.deps, cancelled(mission, reason), {
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
