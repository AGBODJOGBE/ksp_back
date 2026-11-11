import { type Agent, normalizeDisplayName, type Team } from '../../domain/agent';
import { type Assignment, overlappingAssignments } from '../../domain/agenda';
import { type CleaningDeps } from '../deps';
import { ADMINISTRATION, requireStaff, SUPERVISION } from '../shared/access';
import { ComplementErrors } from '../shared/complement-errors';
import { CleaningErrors } from '../shared/errors';
import { optionalText, parseSlot, requiredText, requireUuid } from '../shared/validation';

/** UC-CL-12 : agents (lecture ouverte à la supervision, pour planifier). */
export class ListAgentsUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  execute(): Promise<Agent[]> {
    requireStaff(SUPERVISION);
    return this.deps.agents.listAgents();
  }
}

/**
 * UC-CL-12 : rattacher un compte KSP existant comme agent. Le rôle cleaning_agent lui-même est
 * attribué dans identity (catalogue des rôles).
 */
export class RegisterAgentUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { agentId: string; displayName: string }): Promise<Agent> {
    const staff = requireStaff(ADMINISTRATION);
    const agentId = requireUuid('agentId', input.agentId);
    const displayName = normalizeDisplayName(input.displayName);
    if (!displayName) throw CleaningErrors.invalid('displayName');
    const agent: Agent = { agentId, displayName, active: true, unavailabilities: [] };
    const now = this.deps.clock.now();
    const created = await this.deps.agents.register(agent, {
      events: [],
      audit: [
        {
          actorId: staff.userId,
          action: 'agent.registered',
          entityType: 'agent',
          entityId: agentId,
          at: now,
        },
      ],
    });
    if (!created) throw CleaningErrors.agentAlreadyRegistered();
    return agent;
  }
}

/**
 * UC-CL-12 : déclarer une indisponibilité (congé, maladie…) : l'agent ne peut plus être affecté sur la
 * période. ADR-053 : si elle chevauche des passages ou des visites déjà planifiés, refus avec leur liste
 * (CLEANING_UNAVAILABILITY_CONFLICT) ; avec `force`, enregistrée quand même, la liste en avertissement.
 */
export class DeclareUnavailabilityUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: {
    agentId: string;
    start: string;
    end: string;
    reason: string;
    force?: boolean | undefined;
  }): Promise<{ agent: Agent; overlapping: Assignment[] }> {
    const staff = requireStaff(ADMINISTRATION);
    const agentId = requireUuid('agentId', input.agentId);
    const [agent] = await this.deps.agents.findAgents([agentId]);
    if (!agent) throw CleaningErrors.agentNotFound([agentId]);
    const unavailability = {
      id: this.deps.ids.next(),
      slot: parseSlot('period', { start: input.start, end: input.end }),
      reason: optionalText('reason', input.reason, 200),
    };
    const { visitDurationMinutes } = await this.deps.catalog.getSettings();
    const overlapping = overlappingAssignments(
      await this.deps.agents.assignments(
        agentId,
        { from: unavailability.slot.start, to: unavailability.slot.end },
        visitDurationMinutes,
      ),
      unavailability.slot,
    );
    if (overlapping.length && !input.force) throw ComplementErrors.unavailabilityConflict(overlapping);
    const now = this.deps.clock.now();
    await this.deps.agents.addUnavailability(agentId, unavailability, {
      events: [],
      audit: [
        {
          actorId: staff.userId,
          action: 'agent.unavailable',
          entityType: 'agent',
          entityId: agentId,
          at: now,
          details: { unavailabilityId: unavailability.id, overlapping: overlapping.length },
        },
      ],
    });
    return {
      agent: { ...agent, unavailabilities: [...agent.unavailabilities, unavailability] },
      overlapping,
    };
  }
}

export class ListTeamsUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  execute(): Promise<Team[]> {
    requireStaff(SUPERVISION);
    return this.deps.agents.listTeams();
  }
}

async function checkedMembers(deps: CleaningDeps, memberIds: string[]): Promise<string[]> {
  const ids = [...new Set(memberIds.map((id, index) => requireUuid(`memberIds[${index}]`, id)))];
  const agents = await deps.agents.findAgents(ids);
  const missing = ids.filter((id) => !agents.some((agent) => agent.agentId === id));
  if (missing.length) throw CleaningErrors.agentNotFound(missing);
  return ids;
}

/** UC-CL-12 : composer une équipe. */
export class CreateTeamUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { name: string; memberIds: string[] }): Promise<Team> {
    const staff = requireStaff(ADMINISTRATION);
    const team: Team = {
      id: this.deps.ids.next(),
      name: requiredText('name', input.name, 100),
      memberIds: await checkedMembers(this.deps, input.memberIds),
      active: true,
    };
    await this.deps.agents.saveTeam(team, {
      events: [],
      audit: [
        {
          actorId: staff.userId,
          action: 'team.created',
          entityType: 'team',
          entityId: team.id,
          at: this.deps.clock.now(),
        },
      ],
    });
    return team;
  }
}

/** UC-CL-12 : renommer une équipe ou changer ses membres. */
export class UpdateTeamUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { teamId: string; name: string; memberIds: string[] }): Promise<Team> {
    const staff = requireStaff(ADMINISTRATION);
    const existing = await this.deps.agents.findTeam(requireUuid('teamId', input.teamId));
    if (!existing) throw CleaningErrors.teamNotFound();
    const team: Team = {
      id: existing.id,
      name: requiredText('name', input.name, 100),
      memberIds: await checkedMembers(this.deps, input.memberIds),
      active: existing.active,
    };
    await this.deps.agents.saveTeam(team, {
      events: [],
      audit: [
        {
          actorId: staff.userId,
          action: 'team.updated',
          entityType: 'team',
          entityId: team.id,
          at: this.deps.clock.now(),
          details: { memberIds: team.memberIds },
        },
      ],
    });
    return team;
  }
}
