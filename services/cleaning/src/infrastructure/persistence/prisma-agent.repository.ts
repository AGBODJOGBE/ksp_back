import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../prisma/generated';
import { type AgentRepository, type Changes } from '../../application/ports';
import { type Agent, type Team, type Unavailability } from '../../domain/agent';
import { PrismaService } from '../prisma/prisma.service';
import { UuidV7Generator } from '../system/system';
import { writeChanges } from './changes';

const ids = new UuidV7Generator();
const AGENT_INCLUDE = { unavailabilities: { orderBy: { startsAt: 'asc' as const } } };

type AgentRow = Prisma.AgentGetPayload<{ include: typeof AGENT_INCLUDE }>;

function toAgent(row: AgentRow): Agent {
  return {
    agentId: row.userId,
    displayName: row.displayName,
    active: row.active,
    unavailabilities: row.unavailabilities.map((u) => ({
      id: u.id,
      slot: { start: u.startsAt, end: u.endsAt },
      reason: u.reason,
    })),
  };
}

@Injectable()
export class PrismaAgentRepository implements AgentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listAgents(): Promise<Agent[]> {
    const rows = await this.prisma.agent.findMany({
      include: AGENT_INCLUDE,
      orderBy: { displayName: 'asc' },
    });
    return rows.map(toAgent);
  }

  async findAgents(agentIds: string[]): Promise<Agent[]> {
    const rows = await this.prisma.agent.findMany({
      where: { userId: { in: agentIds } },
      include: AGENT_INCLUDE,
    });
    return rows.map(toAgent);
  }

  async register(agent: Agent, changes: Changes): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.agent.createMany({
        data: [{ userId: agent.agentId, displayName: agent.displayName, active: agent.active }],
        skipDuplicates: true,
      });
      if (count === 1) await writeChanges(tx, changes, () => ids.next());
      return count === 1;
    });
  }

  async addUnavailability(agentId: string, unavailability: Unavailability, changes: Changes): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.agentUnavailability.create({
        data: {
          id: unavailability.id,
          agentId,
          startsAt: unavailability.slot.start,
          endsAt: unavailability.slot.end,
          reason: unavailability.reason,
        },
      });
      await writeChanges(tx, changes, () => ids.next());
    });
  }

  async listTeams(): Promise<Team[]> {
    const rows = await this.prisma.team.findMany({ include: { members: true }, orderBy: { name: 'asc' } });
    return rows.map((row) => ({ id: row.id, name: row.name, memberIds: row.members.map((m) => m.agentId) }));
  }

  async findTeam(teamId: string): Promise<Team | null> {
    const row = await this.prisma.team.findUnique({ where: { id: teamId }, include: { members: true } });
    return row ? { id: row.id, name: row.name, memberIds: row.members.map((m) => m.agentId) } : null;
  }

  async saveTeam(team: Team, changes: Changes): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.team.upsert({
        where: { id: team.id },
        create: { id: team.id, name: team.name },
        update: { name: team.name },
      });
      await tx.teamMember.deleteMany({ where: { teamId: team.id } });
      await tx.teamMember.createMany({
        data: team.memberIds.map((agentId) => ({ teamId: team.id, agentId })),
      });
      await writeChanges(tx, changes, () => ids.next());
    });
  }
}
