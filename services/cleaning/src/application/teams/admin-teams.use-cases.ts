import { type Agent, normalizeDisplayName, type Team } from '../../domain/agent';
import { type CleaningDeps } from '../deps';
import { ADMINISTRATION, requireStaff, SUPERVISION } from '../shared/access';
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

/** UC-CL-12 : déclarer une indisponibilité (congé, maladie…) : l'agent ne peut plus être affecté sur la période. */
export class DeclareUnavailabilityUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { agentId: string; start: string; end: string; reason: string }): Promise<Agent> {
    const staff = requireStaff(ADMINISTRATION);
    const agentId = requireUuid('agentId', input.agentId);
    const [agent] = await this.deps.agents.findAgents([agentId]);
    if (!agent) throw CleaningErrors.agentNotFound([agentId]);
    const unavailability = {
      id: this.deps.ids.next(),
      slot: parseSlot('period', { start: input.start, end: input.end }),
      reason: optionalText('reason', input.reason, 200),
    };
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
        },
      ],
    });
    return { ...agent, unavailabilities: [...agent.unavailabilities, unavailability] };
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
