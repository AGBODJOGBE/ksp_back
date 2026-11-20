import { type CleaningDeps } from '../deps';
import { type AuditEntry } from '../ports';
import { audit } from '../planning/assignment-support';
import { requireStaff } from '../shared/access';
import { cleaningErrors } from '../shared/errors';
import { replayed } from '../shared/idempotency';
import { idempotencyKey, isOffsetCursor, page, type Page, requestHash, text } from '../shared/input';
import { type TeamRecord } from './agent.ports';

/**
 * Équipes (UC-NT-36, partie 9.3) : un nom, un chef d'équipe et des membres ; désactivée, jamais
 * supprimée. Les affectations déjà faites restent quand l'équipe change ou se désactive.
 */
export class TeamUseCases {
  constructor(private readonly deps: CleaningDeps) {}

  async list(input: { active?: boolean | null; limit?: number; cursor?: string }): Promise<Page<TeamRecord>> {
    requireStaff();
    return this.deps.planning.listTeams(
      { active: input.active ?? null },
      page(input.limit, input.cursor, isOffsetCursor),
    );
  }

  async get(teamId: string): Promise<TeamRecord> {
    requireStaff();
    return this.requireTeam(teamId);
  }

  async create(input: {
    idempotencyKey: string;
    name: string;
    leadAgentId: string;
    memberIds: string[];
  }): Promise<TeamRecord> {
    const actorId = requireStaff();
    const key = idempotencyKey(input.idempotencyKey);
    const name = requiredName(input.name);
    if (!input.leadAgentId) throw cleaningErrors.invalid('leadAgentId', 'required');
    // Le chef d'équipe est membre de l'équipe.
    const memberIds = [...new Set([input.leadAgentId, ...input.memberIds])];
    const hash = requestHash({ name, leadAgentId: input.leadAgentId, memberIds });
    const ref = { actorId, operation: 'team.create', key };
    const replay = await replayed<{ teamId: string }>(this.deps.planning, ref, hash);
    if (replay) return this.requireTeam(replay.teamId);
    await this.requireMembers(memberIds);
    const id = this.deps.ids.next();
    const now = this.deps.clock.now();
    await this.deps.planning.transaction(async (tx) => {
      await tx.insertTeam({ id, name, leadAgentId: input.leadAgentId, createdAt: now }, memberIds);
      await tx.write({
        events: [],
        audit: [
          audit(actorId, 'team.created', 'team', id, now, { leadAgentId: input.leadAgentId, memberIds }),
        ],
      });
      await tx.remember({ ...ref, requestHash: hash, response: { teamId: id } });
    });
    return this.requireTeam(id);
  }

  /** Champs absents inchangés ; le chef reste toujours membre de l'équipe. */
  async update(input: {
    teamId: string;
    name?: string | null;
    leadAgentId?: string | null;
    memberIds?: string[] | null;
    active?: boolean | null;
  }): Promise<TeamRecord> {
    const actorId = requireStaff();
    const team = await this.requireTeam(input.teamId);
    const name = input.name === undefined || input.name === null ? undefined : requiredName(input.name);
    const leadAgentId = input.leadAgentId || team.leadAgentId;
    const memberIds = input.memberIds ? [...new Set(input.memberIds)] : null;
    const members = memberIds ?? team.members.map((m) => m.agentId);
    if (!members.includes(leadAgentId)) throw cleaningErrors.invalid('leadAgentId', 'required');
    await this.requireMembers([...new Set([leadAgentId, ...members])]);
    const now = this.deps.clock.now();
    const trail: AuditEntry[] = [];
    if (name !== undefined || input.leadAgentId || memberIds) {
      trail.push(
        audit(actorId, 'team.updated', 'team', team.id, now, {
          before: { leadAgentId: team.leadAgentId, memberIds: team.members.map((m) => m.agentId) },
          after: { leadAgentId, memberIds: members },
        }),
      );
    }
    if (typeof input.active === 'boolean' && input.active !== team.active) {
      trail.push(
        audit(actorId, input.active ? 'team.reactivated' : 'team.deactivated', 'team', team.id, now),
      );
    }
    await this.deps.planning.transaction(async (tx) => {
      await tx.updateTeam(
        team.id,
        {
          ...(name !== undefined ? { name } : {}),
          ...(input.leadAgentId ? { leadAgentId } : {}),
          ...(typeof input.active === 'boolean' ? { active: input.active } : {}),
          updatedAt: now,
        },
        memberIds,
      );
      await tx.write({ events: [], audit: trail });
    });
    return this.requireTeam(team.id);
  }

  private async requireTeam(teamId: string): Promise<TeamRecord> {
    const team = await this.deps.planning.teamById(teamId);
    if (!team) throw cleaningErrors.teamNotFound();
    return team;
  }

  private async requireMembers(ids: readonly string[]): Promise<void> {
    if ((await this.deps.planning.agentsByIds(ids)).length !== ids.length)
      throw cleaningErrors.agentNotFound();
  }
}

function requiredName(value: string): string {
  const name = text(value, 'name');
  if (!name) throw cleaningErrors.invalid('name', 'required');
  return name;
}
