import {
  canChangeSchedule,
  releasedAgents,
  rescheduledIntervention,
  unscheduledIntervention,
} from '../../domain/intervention-changes';
import {
  deriveMissionStatus,
  type Intervention,
  isTerminalMission,
  type Mission,
} from '../../domain/mission';
import { conflictingAgents, slotFrom } from '../../domain/schedule';
import { type CleaningDeps, missionView, type MissionView } from '../deps';
import { requireStaff, SUPERVISION } from '../shared/access';
import { CleaningErrors } from '../shared/errors';
import { eventSubject } from '../shared/event-subject';
import { parseDate, requiredText, requirePositiveInt, requireUuid } from '../shared/validation';
import { resolveAgents } from './admin-missions.use-cases';
import { saveMission } from './customer-missions.use-cases';

/**
 * Gestion d'un passage seul au back-office (ADR-053) : reporter un passage planifié, ou l'annuler pour
 * le replanifier. Supervision seulement ; le motif est gardé sur le passage, jamais dans les
 * événements ni les messages.
 */
async function plannedIntervention(
  deps: CleaningDeps,
  interventionIdInput: string,
  to: string,
): Promise<{ mission: Mission; intervention: Intervention }> {
  const interventionId = requireUuid('interventionId', interventionIdInput);
  const mission = await deps.missions.findByInterventionId(interventionId);
  const intervention = mission?.interventions.find((item) => item.id === interventionId);
  if (!mission || !intervention) throw CleaningErrors.interventionNotFound();
  if (isTerminalMission(mission.status)) throw CleaningErrors.invalidTransition(mission.status, to);
  if (!canChangeSchedule(intervention)) throw CleaningErrors.invalidTransition(intervention.status, to);
  return { mission, intervention };
}

function replaced(mission: Mission, intervention: Intervention, now: Date): Mission {
  const updated: Mission = {
    ...mission,
    interventions: mission.interventions.map((item) => (item.id === intervention.id ? intervention : item)),
    updatedAt: now,
  };
  return { ...updated, status: deriveMissionStatus(updated) };
}

export interface RescheduleInterventionInput {
  interventionId: string;
  scheduledStart: string;
  /** 0 : durée inchangée. */
  durationMinutes: number;
  /** Tous deux vides : agents du passage gardés (toujours actifs). */
  agentIds: string[];
  teamId: string;
  reason: string;
}

/**
 * Reporter un passage planifié : nouveau début dans le futur, mêmes contrôles que la planification
 * (agents actifs, conflits d'agenda avec verrou, CLEANING_TEAM_UNAVAILABLE), mission suspendue refusée.
 * Publie cleaning.intervention.rescheduled (client, agents gardés ou ajoutés, agents libérés).
 */
export class RescheduleInterventionUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: RescheduleInterventionInput): Promise<MissionView> {
    const staff = requireStaff(SUPERVISION);
    const { mission, intervention } = await plannedIntervention(
      this.deps,
      input.interventionId,
      'rescheduled',
    );
    if (mission.suspension) throw CleaningErrors.contractSuspended();
    const reason = requiredText('reason', input.reason, 500);
    const now = this.deps.clock.now();
    const start = parseDate('scheduledStart', input.scheduledStart);
    if (start <= now) throw CleaningErrors.slotInvalid('Le passage doit être planifié dans le futur.');
    const durationMinutes = input.durationMinutes
      ? requirePositiveInt('durationMinutes', input.durationMinutes, 24 * 60)
      : intervention.durationMinutes;
    const changesAgents = input.agentIds.length > 0 || Boolean(input.teamId);
    const agentIds = changesAgents
      ? await resolveAgents(this.deps, input.agentIds, input.teamId)
      : await resolveAgents(this.deps, intervention.agentIds, '');

    const next = rescheduledIntervention(intervention, { start, durationMinutes, agentIds, reason });
    const updated = replaced(mission, next, now);
    const slot = slotFrom(start, durationMinutes);
    const subject = await eventSubject(this.deps, mission);
    const previousStart = intervention.scheduledStart.toISOString();
    const result = await this.deps.missions.scheduleIntervention(
      updated,
      next,
      // Missions du même groupe (même lieu) : la même équipe peut y enchaîner (ADR-035).
      (busy) => conflictingAgents(agentIds, slot, busy, mission.groupId),
      {
        events: [
          {
            type: 'cleaning.intervention.rescheduled',
            payload: {
              ...subject,
              missionId: mission.id,
              interventionId: intervention.id,
              customerId: mission.customerId,
              previousStart,
              scheduledStart: start.toISOString(),
              durationMinutes,
              agentIds,
              releasedAgentIds: releasedAgents(intervention, next),
            },
          },
        ],
        audit: [
          {
            actorId: staff.userId,
            action: 'intervention.rescheduled',
            entityType: 'mission',
            entityId: mission.id,
            at: now,
            details: {
              interventionId: intervention.id,
              previousStart,
              scheduledStart: start.toISOString(),
              agentIds,
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

/**
 * Annuler un passage planifié pour le replanifier : le passage est annulé (cause « unscheduled »), la
 * mission retrouve un passage à planifier. Le nombre de passages prévus ne change pas : aucun effet
 * sur l'argent (la suppression d'un passage avec remboursement est prévue en phase 2). Publie
 * cleaning.intervention.unscheduled (client et agents libérés).
 */
export class UnscheduleInterventionUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { interventionId: string; reason: string }): Promise<MissionView> {
    const staff = requireStaff(SUPERVISION);
    const { mission, intervention } = await plannedIntervention(this.deps, input.interventionId, 'cancelled');
    const reason = requiredText('reason', input.reason, 500);
    const now = this.deps.clock.now();
    const subject = await eventSubject(this.deps, mission);
    const previousStart = intervention.scheduledStart.toISOString();
    return saveMission(
      this.deps,
      replaced(mission, unscheduledIntervention(intervention, reason, now), now),
      {
        events: [
          {
            type: 'cleaning.intervention.unscheduled',
            payload: {
              ...subject,
              missionId: mission.id,
              interventionId: intervention.id,
              customerId: mission.customerId,
              previousStart,
              releasedAgentIds: [...new Set(intervention.agentIds)],
            },
          },
        ],
        audit: [
          {
            actorId: staff.userId,
            action: 'intervention.unscheduled',
            entityType: 'mission',
            entityId: mission.id,
            at: now,
            details: { interventionId: intervention.id, previousStart },
          },
        ],
      },
    );
  }
}
