import { type Mission } from '../../domain/mission';
import { selectSchedulable } from '../../domain/request-group';
import { conflictingAgents, slotFrom } from '../../domain/schedule';
import { type CleaningDeps } from '../deps';
import { type AuditEntry, type GroupOutcome, type OutboxMessage } from '../ports';
import { resolveAgents, scheduledChanges, withNewIntervention } from '../missions/admin-missions.use-cases';
import { requireStaff, SUPERVISION } from '../shared/access';
import { CleaningErrors } from '../shared/errors';
import { parseDate, requirePositiveInt, requireUuid } from '../shared/validation';
import { emptyOutcome, operationRecord, parseKey, previousOutcome } from './group-support';

export interface ScheduleGroupInterventionsInput {
  groupId: string;
  missionIds: string[];
  scheduledStart: string;
  durationMinutes: number;
  agentIds: string[];
  teamId: string;
  idempotencyKey?: string;
}

/**
 * Planification commune des missions d'un groupe (ADR-035) : un passage par mission, même créneau,
 * mêmes agents, dans une transaction. Les passages des missions du même groupe (même lieu) ne sont
 * pas des conflits ; les autres passages et les indisponibilités le restent
 * (CLEANING_TEAM_UNAVAILABLE).
 */
export class ScheduleGroupInterventionsUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(
    input: ScheduleGroupInterventionsInput,
  ): Promise<{ outcome: GroupOutcome; missions: Mission[] }> {
    const staff = requireStaff(SUPERVISION);
    const key = parseKey(input.idempotencyKey, false);
    const groupId = requireUuid('groupId', input.groupId);
    const all = await this.deps.missions.listForGroup(groupId);
    if (!all.length) throw CleaningErrors.missionNotFound();
    const replay = await previousOutcome(this.deps, staff.userId, 'interventions.scheduled', key, groupId);
    if (replay) return this.reload(replay);

    const wanted = input.missionIds.map((id, index) => requireUuid(`missionIds[${index}]`, id));
    if (wanted.some((id) => !all.some((mission) => mission.id === id)))
      throw CleaningErrors.missionNotFound();
    const { selected, skipped } = selectSchedulable(
      wanted.length ? all.filter((mission) => wanted.includes(mission.id)) : all,
    );
    if (!selected.length) throw CleaningErrors.groupNothingEligible(skipped);
    const now = this.deps.clock.now();
    const start = parseDate('scheduledStart', input.scheduledStart);
    if (start <= now) throw CleaningErrors.slotInvalid('Le passage doit être planifié dans le futur.');
    const durationMinutes = requirePositiveInt('durationMinutes', input.durationMinutes, 24 * 60);
    const agentIds = await resolveAgents(this.deps, input.agentIds, input.teamId);

    const updated: Mission[] = [];
    const events: OutboxMessage[] = [];
    const audit: AuditEntry[] = [];
    for (const mission of selected) {
      const planned = await withNewIntervention(this.deps, mission, start, durationMinutes, agentIds, now);
      updated.push(planned.mission);
      const changes = await scheduledChanges(this.deps, staff.userId, mission, planned.intervention, now, {
        groupId,
      });
      events.push(...changes.events);
      audit.push(...changes.audit);
    }
    const outcome: GroupOutcome = {
      ...emptyOutcome(groupId),
      affectedIds: updated.map((mission) => mission.id),
      skippedMissions: skipped,
      missionIds: updated.map((mission) => mission.id),
    };
    audit.push({
      actorId: staff.userId,
      action: 'mission_group.interventions_scheduled',
      entityType: 'mission_group',
      entityId: groupId,
      at: now,
      details: { missionIds: outcome.missionIds, agentIds, scheduledStart: start.toISOString() },
    });
    const slot = slotFrom(start, durationMinutes);
    const written = await this.deps.missions.scheduleGroup({
      missions: updated,
      agentIds,
      conflicts: (busy) => conflictingAgents(agentIds, slot, busy, groupId),
      changes: { events, audit },
      operation: operationRecord(staff.userId, 'interventions.scheduled', key, outcome),
    });
    if (written.conflicts.length) throw CleaningErrors.teamUnavailable(written.conflicts);
    if (written.outcome === 'replayed') {
      const previous = await previousOutcome(
        this.deps,
        staff.userId,
        'interventions.scheduled',
        key,
        groupId,
      );
      if (previous) return this.reload(previous);
    }
    if (written.outcome !== 'saved') throw CleaningErrors.concurrentUpdate();
    return { outcome, missions: updated.map((mission) => ({ ...mission, version: mission.version + 1 })) };
  }

  private async reload(outcome: GroupOutcome) {
    const missions = await this.deps.missions.listForGroup(outcome.groupId);
    return { outcome, missions: missions.filter((mission) => outcome.missionIds.includes(mission.id)) };
  }
}
