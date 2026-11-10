import { type Agent, type Team } from '../../domain/agent';
import { upcomingAssignments } from '../../domain/agenda';
import { type CleaningDeps } from '../deps';
import { type AuditEntry } from '../ports';
import { ADMINISTRATION, requireStaff } from '../shared/access';
import { ComplementErrors } from '../shared/complement-errors';
import { CleaningErrors } from '../shared/errors';
import { requireUuid } from '../shared/validation';

/**
 * Agents et équipes, compléments (ADR-053) : désactivation et réactivation, sans suppression ;
 * suppression d'une indisponibilité. Réservé à cleaning_admin et super_admin.
 */
async function agentOf(deps: CleaningDeps, agentIdInput: string): Promise<Agent> {
  const agentId = requireUuid('agentId', agentIdInput);
  const [agent] = await deps.agents.findAgents([agentId]);
  if (!agent) throw CleaningErrors.agentNotFound([agentId]);
  return agent;
}

async function teamOf(deps: CleaningDeps, teamIdInput: string): Promise<Team> {
  const team = await deps.agents.findTeam(requireUuid('teamId', teamIdInput));
  if (!team) throw CleaningErrors.teamNotFound();
  return team;
}

function audit(actorId: string, action: string, entityType: 'agent' | 'team', entityId: string, at: Date) {
  return { events: [], audit: [{ actorId, action, entityType, entityId, at } satisfies AuditEntry] };
}

/**
 * Désactiver un agent : refusé tant qu'il a des passages actifs ou des visites planifiées à venir
 * (CLEANING_AGENT_HAS_ASSIGNMENTS, avec la liste) : la supervision les reporte ou les réaffecte
 * d'abord. Aucune réaffectation automatique (choix le plus sûr). Sans effet sur un agent déjà inactif.
 */
export class DeactivateAgentUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(agentId: string): Promise<Agent> {
    const staff = requireStaff(ADMINISTRATION);
    const agent = await agentOf(this.deps, agentId);
    if (!agent.active) return agent;
    const now = this.deps.clock.now();
    const { visitDurationMinutes } = await this.deps.catalog.getSettings();
    const upcoming = upcomingAssignments(
      await this.deps.agents.assignments(agent.agentId, { from: now, to: null }, visitDurationMinutes),
      now,
    );
    if (upcoming.length) throw ComplementErrors.agentHasAssignments(upcoming);
    await this.deps.agents.setAgentActive(
      agent.agentId,
      false,
      audit(staff.userId, 'agent.deactivated', 'agent', agent.agentId, now),
    );
    return { ...agent, active: false };
  }
}

export class ReactivateAgentUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(agentId: string): Promise<Agent> {
    const staff = requireStaff(ADMINISTRATION);
    const agent = await agentOf(this.deps, agentId);
    if (agent.active) return agent;
    const now = this.deps.clock.now();
    await this.deps.agents.setAgentActive(
      agent.agentId,
      true,
      audit(staff.userId, 'agent.reactivated', 'agent', agent.agentId, now),
    );
    return { ...agent, active: true };
  }
}

/** Supprimer une indisponibilité déclarée par erreur ou levée (CLEANING_UNAVAILABILITY_NOT_FOUND sinon). */
export class RemoveUnavailabilityUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { agentId: string; unavailabilityId: string }): Promise<Agent> {
    const staff = requireStaff(ADMINISTRATION);
    const agent = await agentOf(this.deps, input.agentId);
    const unavailabilityId = requireUuid('unavailabilityId', input.unavailabilityId);
    const removed = await this.deps.agents.removeUnavailability(agent.agentId, unavailabilityId, {
      events: [],
      audit: [
        {
          actorId: staff.userId,
          action: 'agent.unavailability_removed',
          entityType: 'agent',
          entityId: agent.agentId,
          at: this.deps.clock.now(),
          details: { unavailabilityId },
        },
      ],
    });
    if (!removed) throw ComplementErrors.unavailabilityNotFound();
    return {
      ...agent,
      unavailabilities: agent.unavailabilities.filter((item) => item.id !== unavailabilityId),
    };
  }
}

/** Désactiver une équipe : gardée (historique des passages), mais plus proposée à la planification. */
export class DeactivateTeamUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(teamId: string): Promise<Team> {
    return setTeamActive(this.deps, teamId, false);
  }
}

export class ReactivateTeamUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(teamId: string): Promise<Team> {
    return setTeamActive(this.deps, teamId, true);
  }
}

async function setTeamActive(deps: CleaningDeps, teamId: string, active: boolean): Promise<Team> {
  const staff = requireStaff(ADMINISTRATION);
  const team = await teamOf(deps, teamId);
  if (team.active === active) return team;
  const action = active ? 'team.reactivated' : 'team.deactivated';
  await deps.agents.setTeamActive(
    team.id,
    active,
    audit(staff.userId, action, 'team', team.id, deps.clock.now()),
  );
  return { ...team, active };
}
