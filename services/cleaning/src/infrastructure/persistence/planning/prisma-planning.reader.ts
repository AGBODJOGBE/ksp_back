import { type TargetRef } from '../../../domain/planning/agenda';
import {
  type AgentRecord,
  type InvitationRecord,
  type PlanningSettings,
  type TeamRecord,
} from '../../../application/agents/agent.ports';
import {
  type AssignmentRecord,
  type PlanningReader,
  type TargetRecord,
} from '../../../application/planning/planning.ports';
import { type Clock } from '../../../application/ports';
import { agentInclude, isUuid, teamInclude, toAgentRecord, toTeamRecord, uuids } from '../agents/agent-rows';
import { type Tx } from '../changes';
import { agendas, findAssignment, loadTargets } from './planning-rows';

/** Invitation telle que les cas d'usage la lisent : l'empreinte du numéro reste dans le dépôt. */
export function toInvitationRecord(row: InvitationRecord & { phoneFingerprint: string }): InvitationRecord {
  const { phoneFingerprint: _fingerprint, ...invitation } = row;
  return invitation;
}

/**
 * Lectures de la planification sur un client Prisma : le client du service (lectures hors
 * transaction) ou celui d'une transaction (lectures sous verrou). Un identifiant mal formé est
 * introuvable, sans requête.
 */
export class PrismaPlanningReader implements PlanningReader {
  constructor(
    protected readonly client: Tx,
    protected readonly clock: Clock,
  ) {}

  async agentById(id: string): Promise<AgentRecord | null> {
    if (!isUuid(id)) return null;
    const row = await this.client.agent.findUnique({
      where: { id },
      include: agentInclude(this.clock.now()),
    });
    return row ? toAgentRecord(row) : null;
  }

  async agentByUserId(userId: string): Promise<AgentRecord | null> {
    if (!isUuid(userId)) return null;
    const row = await this.client.agent.findUnique({
      where: { userId },
      include: agentInclude(this.clock.now()),
    });
    return row ? toAgentRecord(row) : null;
  }

  /** Piste A : invitation d'un agent, sans son empreinte. */
  async invitationById(id: string): Promise<InvitationRecord | null> {
    if (!isUuid(id)) return null;
    const row = await this.client.agentInvitation.findUnique({ where: { id } });
    return row ? toInvitationRecord(row) : null;
  }

  async agentsByIds(ids: readonly string[]): Promise<AgentRecord[]> {
    const valid = uuids(ids);
    if (!valid.length) return [];
    const rows = await this.client.agent.findMany({
      where: { id: { in: valid } },
      include: agentInclude(this.clock.now()),
    });
    return rows.map(toAgentRecord);
  }

  async teamById(id: string): Promise<TeamRecord | null> {
    if (!isUuid(id)) return null;
    const row = await this.client.team.findUnique({ where: { id }, include: teamInclude });
    return row ? toTeamRecord(row) : null;
  }

  agendas(agentIds: readonly string[], window: { start: Date; end: Date | null }) {
    return agendas(this.client, uuids(agentIds), window);
  }

  /** Cibles trouvées, dans l'ordre demandé. */
  async targets(refs: readonly TargetRef[]): Promise<TargetRecord[]> {
    const ids = (kind: TargetRef['kind']) => uuids(refs.filter((r) => r.kind === kind).map((r) => r.id));
    const found = await loadTargets(this.client, ids('session'), ids('visit'), this.clock.now());
    return refs.flatMap((ref) => found.filter((t) => t.target.kind === ref.kind && t.target.id === ref.id));
  }

  async assignment(id: string): Promise<AssignmentRecord | null> {
    return isUuid(id) ? findAssignment(this.client, id) : null;
  }

  async settings(): Promise<PlanningSettings> {
    const row = await this.client.cleaningSettings.findUniqueOrThrow({ where: { id: 1 } });
    return {
      defaultTravelMinutes: row.defaultTravelMinutes,
      assignmentResponseHours: row.assignmentResponseHours,
      defaultMaxHoursDay: row.defaultMaxHoursDay,
      defaultMaxHoursWeek: row.defaultMaxHoursWeek,
    };
  }
}
