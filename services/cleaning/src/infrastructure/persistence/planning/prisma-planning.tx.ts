import { Prisma } from '../../../../prisma/generated';
import {
  AgentAlreadyRegisteredError,
  type AgentPatch,
  ConcurrentUpdateError,
  type InvitationRecord,
  type NewAgent,
  type NewInvitation,
  type TeamPatch,
} from '../../../application/agents/agent.ports';
import {
  type IdempotencyRecord,
  type NewAssignment,
  type NewUnavailability,
  type PlanningTx,
  ScheduleOverlapError,
} from '../../../application/planning/planning.ports';
import { type Changes, type Clock, type IdGenerator } from '../../../application/ports';
import { uuids } from '../agents/agent-rows';
import { json, type Tx, writeChanges } from '../changes';
import { IN_FORCE } from './planning-rows';
import { PrismaPlanningReader, toInvitationRecord } from './prisma-planning.reader';

/** Violation d'une contrainte unique (Prisma P2002). */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Violation de la contrainte d'exclusion assignments_no_overlap (SQLSTATE 23P01) : Prisma la
 * remonte sans code propre, le nom de la contrainte figure dans le message.
 */
export function isOverlapViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return message.includes('assignments_no_overlap') || message.includes('23P01');
}

/** Écritures de la planification dans une transaction Prisma. */
export class PrismaPlanningTx extends PrismaPlanningReader implements PlanningTx {
  constructor(
    client: Tx,
    clock: Clock,
    private readonly ids: IdGenerator,
  ) {
    super(client, clock);
  }

  /** Verrou de l'agenda (RV-75) : lignes agents verrouillées dans l'ordre des identifiants. */
  async lockAgents(ids: readonly string[]): Promise<void> {
    const valid = uuids(ids).sort();
    if (!valid.length) return;
    await this.client
      .$queryRaw`SELECT id FROM agents WHERE id = ANY(${valid}::uuid[]) ORDER BY id FOR UPDATE`;
  }

  async insertAgent(agent: NewAgent): Promise<void> {
    try {
      await this.client.agent.create({ data: { ...agent, updatedAt: agent.createdAt } });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AgentAlreadyRegisteredError();
      throw error;
    }
  }

  async updateAgent(id: string, expectedVersion: number, patch: AgentPatch): Promise<void> {
    const { count } = await this.client.agent.updateMany({
      where: { id, version: expectedVersion },
      data: { ...patch, version: { increment: 1 } },
    });
    if (count !== 1) throw new ConcurrentUpdateError();
  }

  async replaceSkills(
    agentId: string,
    skills: readonly { code: string; status: 'declared' | 'validated' | 'rejected' }[],
    by: string | null,
    at: Date,
  ): Promise<void> {
    await this.client.agentSkill.deleteMany({ where: { agentId } });
    await this.client.agentSkill.createMany({
      data: skills.map((skill) => ({
        agentId,
        skillCode: skill.code,
        status: skill.status,
        ...(skill.status !== 'declared' ? { reviewedBy: by, reviewedAt: at } : {}),
      })),
    });
  }

  async replaceZones(agentId: string, zoneKeys: readonly string[]): Promise<void> {
    await this.client.agentZone.deleteMany({ where: { agentId } });
    await this.client.agentZone.createMany({ data: zoneKeys.map((communeKey) => ({ agentId, communeKey })) });
  }

  async replaceWeekly(
    agentId: string,
    ranges: readonly { weekday: number; startMinute: number; endMinute: number }[],
    by: string,
    at: Date,
  ): Promise<void> {
    await this.client.availabilityRule.deleteMany({ where: { agentId } });
    await this.client.availabilityRule.createMany({
      data: ranges.map((range) => ({ id: this.ids.next(), agentId, ...range, updatedBy: by, updatedAt: at })),
    });
  }

  async replaceExtras(
    agentId: string,
    extras: readonly { id: string; start: Date; end: Date }[],
    by: string,
    at: Date,
  ): Promise<void> {
    await this.client.unavailability.deleteMany({ where: { agentId, kind: 'extra_availability' } });
    await this.client.unavailability.createMany({
      data: extras.map((extra) => ({
        id: extra.id,
        agentId,
        kind: 'extra_availability' as const,
        startsAt: extra.start,
        endsAt: extra.end,
        createdBy: by,
        createdAt: at,
      })),
    });
  }

  async insertUnavailability(row: NewUnavailability): Promise<void> {
    await this.client.unavailability.create({
      data: {
        id: row.id,
        agentId: row.agentId,
        kind: row.kind,
        startsAt: row.start,
        endsAt: row.end,
        reason: row.reason,
        note: row.note,
        forced: row.forced,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
      },
    });
  }

  async deleteUnavailability(agentId: string, id: string): Promise<boolean> {
    if (!uuids([id]).length) return false;
    const { count } = await this.client.unavailability.deleteMany({
      where: { id, agentId, kind: 'unavailable' },
    });
    return count === 1;
  }

  async insertTeam(
    team: { id: string; name: string; leadAgentId: string; createdAt: Date },
    memberIds: readonly string[],
  ): Promise<void> {
    await this.client.team.create({
      data: {
        ...team,
        updatedAt: team.createdAt,
        members: { createMany: { data: memberIds.map((agentId) => ({ agentId })) } },
      },
    });
  }

  async updateTeam(id: string, patch: TeamPatch, memberIds: readonly string[] | null): Promise<void> {
    await this.client.team.update({ where: { id }, data: patch });
    if (memberIds) {
      await this.client.teamMember.deleteMany({ where: { teamId: id } });
      await this.client.teamMember.createMany({
        data: memberIds.map((agentId) => ({ teamId: id, agentId })),
      });
    }
  }

  /** Contrainte d'exclusion → ScheduleOverlapError ; index unique (même agent, second chef) → conflit. */
  async insertAssignments(rows: readonly NewAssignment[]): Promise<void> {
    try {
      await this.client.assignment.createMany({
        data: rows.map((row) => ({
          id: row.id,
          targetKind: row.target.kind,
          visitId: row.target.kind === 'visit' ? row.target.id : null,
          sessionId: row.target.kind === 'session' ? row.target.id : null,
          agentId: row.agentId,
          isLead: row.isLead,
          source: row.source,
          status: row.status,
          responseDueAt: row.respondBefore,
          occupiedFrom: row.occupiedFrom,
          occupiedUntil: row.occupiedUntil,
          travelMinutes: row.travelMinutes,
          overrides: row.overrides,
          reason: row.reason,
          createdBy: row.createdBy,
          createdAt: row.createdAt,
        })),
      });
    } catch (error) {
      if (isOverlapViolation(error)) throw new ScheduleOverlapError();
      if (isUniqueViolation(error)) throw new ConcurrentUpdateError();
      throw error;
    }
  }

  async removeAssignments(
    ids: readonly string[],
    removal: { by: string | null; reason: string; at: Date },
  ): Promise<void> {
    await this.client.assignment.updateMany({
      where: { id: { in: [...ids] }, status: { in: IN_FORCE } },
      data: {
        status: 'removed',
        removedAt: removal.at,
        removedBy: removal.by,
        removalReason: removal.reason,
      },
    });
  }

  async respondAssignment(id: string, status: 'confirmed' | 'declined', at: Date): Promise<void> {
    await this.client.assignment.update({ where: { id }, data: { status, respondedAt: at } });
  }

  async setLead(id: string, isLead: boolean): Promise<void> {
    await this.client.assignment.update({ where: { id }, data: { isLead } });
  }

  async setSessionStatus(sessionId: string, status: 'to_assign' | 'assigned', at: Date): Promise<void> {
    await this.client.session.update({
      where: { id: sessionId },
      data: { status, updatedAt: at, version: { increment: 1 } },
    });
  }

  write(changes: Changes): Promise<void> {
    return writeChanges(this.client, changes, () => this.ids.next());
  }

  // --- Piste A (agents) : invitations (R-AG-02) ---

  async openInvitation(row: NewInvitation): Promise<InvitationRecord> {
    const open = await this.client.agentInvitation.findFirst({
      where: { phoneFingerprint: row.phoneFingerprint, consumedAt: null },
    });
    try {
      const saved = open
        ? await this.client.agentInvitation.update({
            where: { id: open.id },
            data: { expiresAt: row.expiresAt, sentAt: null },
          })
        : await this.client.agentInvitation.create({ data: row });
      return toInvitationRecord(saved);
    } catch (error) {
      // Index unique des invitations en cours : un autre appel vient d'inviter ce numéro.
      if (isUniqueViolation(error)) throw new ConcurrentUpdateError();
      throw error;
    }
  }

  async recordInvitationSend(id: string, sentAt: Date | null): Promise<void> {
    await this.client.agentInvitation.update({
      where: { id },
      data: { sendAttempts: { increment: 1 }, ...(sentAt ? { sentAt } : {}) },
    });
  }

  async consumeInvitation(id: string, agentId: string, at: Date): Promise<boolean> {
    const { count } = await this.client.agentInvitation.updateMany({
      where: { id, consumedAt: null, expiresAt: { gt: at } },
      data: { consumedAt: at, agentId, phoneEncrypted: null },
    });
    return count === 1;
  }

  async remember(record: IdempotencyRecord): Promise<void> {
    try {
      await this.client.idempotencyRecord.create({
        data: {
          actorId: record.actorId,
          operation: record.operation,
          idempotencyKey: record.key,
          requestHash: record.requestHash,
          response: json(record.response),
          createdAt: this.clock.now(),
        },
      });
    } catch (error) {
      // Même clé enregistrée par un appel concurrent : relire et recommencer.
      if (isUniqueViolation(error)) throw new ConcurrentUpdateError();
      throw error;
    }
  }
}
