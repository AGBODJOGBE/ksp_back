import { checkAvailabilityChange, checkUnavailabilityDeclaration } from '../../domain/planning/availability';
import { type CleaningDeps } from '../deps';
import { type AuditEntry } from '../ports';
import { assignmentsByIds, audit, releaseAssignments } from '../planning/assignment-support';
import { type PlanningTx } from '../planning/planning.ports';
import { requireConnectedUser, requireStaff } from '../shared/access';
import { cleaningErrors, refusal } from '../shared/errors';
import { replayed, writeError } from '../shared/idempotency';
import { hoursLimit, idempotencyKey, period, requestHash, text } from '../shared/input';
import { type AgentRecord } from './agent.ports';
import { availabilityView, type AvailabilityView, parseExtras, parseWeekly } from './agent-views';

/**
 * Disponibilités d'un agent (UC-NT-20 côté agent, UC-NT-35 côté superviseur ; partie 9.2) : modèle
 * hebdomadaire, disponibilités exceptionnelles, indisponibilités, charge maximale. Toute écriture
 * pose le verrou de l'agenda de l'agent, comme une affectation.
 */

type Actor = { actorId: string; agent: AgentRecord; bySupervisor: boolean };

export interface AvailabilityInput {
  weekly: { weekday: string; ranges: { start: string; end: string }[] }[];
  extraAvailabilities: { start: string; end: string }[];
}

export interface UnavailabilityInput {
  idempotencyKey: string;
  start: string;
  end: string;
  kind: string;
  note?: string | null;
}

const KINDS = ['leave', 'sickness', 'other'] as const;
/** Motif système des affectations retirées par une indisponibilité ou un changement forcé (R-PL-09). */
const RELEASE_REASON = 'agent_unavailable';

export class AvailabilityUseCases {
  constructor(private readonly deps: CleaningDeps) {}

  async getMine(): Promise<AvailabilityView> {
    const { agent } = await this.me();
    return availabilityView(this.deps, agent);
  }

  async getFor(agentId: string): Promise<AvailabilityView> {
    const { agent } = await this.staff(agentId);
    return availabilityView(this.deps, agent);
  }

  async setMine(input: AvailabilityInput): Promise<AvailabilityView> {
    return this.set(await this.me(), input, {});
  }

  /** Superviseur : retirer une plage occupée demande force (affectations touchées retirées). */
  async setFor(
    input: AvailabilityInput & {
      agentId: string;
      maxHoursPerDay?: number | null;
      maxHoursPerWeek?: number | null;
      force?: boolean | null;
    },
  ): Promise<AvailabilityView> {
    const actor = await this.staff(input.agentId);
    return this.set({ ...actor, bySupervisor: input.force ?? false }, input, {
      maxHoursDay: hoursLimit(input.maxHoursPerDay, 'maxHoursPerDay', 24),
      maxHoursWeek: hoursLimit(input.maxHoursPerWeek, 'maxHoursPerWeek', 168),
    });
  }

  async declareMine(input: UnavailabilityInput): Promise<AvailabilityView> {
    return this.declare(await this.me(), input);
  }

  /** Superviseur : une indisponibilité qui chevauche des affectations passe avec force (R-DS-04). */
  async declareFor(
    input: UnavailabilityInput & { agentId: string; force?: boolean | null },
  ): Promise<AvailabilityView> {
    const actor = await this.staff(input.agentId);
    return this.declare({ ...actor, bySupervisor: input.force ?? false }, input);
  }

  async removeMine(unavailabilityId: string): Promise<AvailabilityView> {
    return this.remove(await this.me(), unavailabilityId);
  }

  async removeFor(agentId: string, unavailabilityId: string): Promise<AvailabilityView> {
    return this.remove(await this.staff(agentId), unavailabilityId);
  }

  private async me(): Promise<Actor> {
    const actorId = requireConnectedUser();
    const agent = await this.deps.planning.agentByUserId(actorId);
    if (!agent) throw cleaningErrors.agentNotFound();
    return { actorId, agent, bySupervisor: false };
  }

  private async staff(agentId: string): Promise<Actor> {
    const actorId = requireStaff();
    const agent = await this.deps.planning.agentById(agentId);
    if (!agent) throw cleaningErrors.agentNotFound();
    return { actorId, agent, bySupervisor: true };
  }

  /** Écriture sous le verrou de l'agenda de l'agent, agent relu ; renvoie ses disponibilités. */
  private async write(
    agentId: string,
    work: (tx: PlanningTx, agent: AgentRecord, now: Date) => Promise<void>,
  ): Promise<AvailabilityView> {
    const now = this.deps.clock.now();
    try {
      await this.deps.planning.transaction(async (tx) => {
        await tx.lockAgents([agentId]);
        const agent = await tx.agentById(agentId);
        if (!agent) throw cleaningErrors.agentNotFound();
        await work(tx, agent, now);
      });
    } catch (error) {
      throw writeError(error);
    }
    return availabilityView(this.deps, (await this.deps.planning.agentById(agentId))!);
  }

  private async set(
    actor: Actor,
    input: AvailabilityInput,
    limits: { maxHoursDay?: number | undefined; maxHoursWeek?: number | undefined },
  ): Promise<AvailabilityView> {
    const weekly = parseWeekly(input.weekly);
    const extras = parseExtras(input.extraAvailabilities, () => this.deps.ids.next());
    return this.write(actor.agent.id, async (tx, agent, now) => {
      const day = limits.maxHoursDay ?? agent.maxHoursDay;
      if (day > (limits.maxHoursWeek ?? agent.maxHoursWeek)) {
        throw cleaningErrors.invalid('maxHoursPerDay', 'out_of_range');
      }
      const agenda = (await tx.agendas([agent.id], { start: now, end: null })).get(agent.id) ?? [];
      const decision = checkAvailabilityChange({
        current: agent.weekly,
        next: weekly,
        extras,
        agenda,
        bySupervisor: actor.bySupervisor,
        now,
      });
      if (!decision.ok) throw refusal(decision.errors);
      const released = await releaseAssignments(tx, await assignmentsByIds(tx, decision.value.toUnassign), {
        actorId: actor.actorId,
        by: actor.actorId,
        reason: RELEASE_REASON,
        cause: 'unavailability',
        at: now,
      });
      await tx.replaceWeekly(agent.id, weekly, actor.actorId, now);
      await tx.replaceExtras(agent.id, extras, actor.actorId, now);
      await tx.updateAgent(agent.id, agent.version, {
        ...(limits.maxHoursDay !== undefined ? { maxHoursDay: limits.maxHoursDay } : {}),
        ...(limits.maxHoursWeek !== undefined ? { maxHoursWeek: limits.maxHoursWeek } : {}),
        updatedAt: now,
      });
      const trail: AuditEntry[] = [...released.audit];
      // R-AU-01 : le changement est tracé quand il vient du superviseur.
      if (actor.agent.userId !== actor.actorId) {
        trail.push(
          audit(actor.actorId, 'agent.availability_changed', 'agent', agent.id, now, {
            ranges: weekly.length,
            extras: extras.length,
            unassigned: decision.value.toUnassign,
          }),
        );
      }
      await tx.write({ events: released.events, audit: trail });
    });
  }

  private async declare(actor: Actor, input: UnavailabilityInput): Promise<AvailabilityView> {
    const key = idempotencyKey(input.idempotencyKey);
    const slot = period(input.start, input.end);
    if (!(KINDS as readonly string[]).includes(input.kind)) {
      throw cleaningErrors.invalid('kind', input.kind ? 'invalid_type' : 'required');
    }
    const note = text(input.note, 'note');
    const hash = requestHash({
      agentId: actor.agent.id,
      ...slot,
      kind: input.kind,
      note,
      force: actor.bySupervisor,
    });
    const ref = { actorId: actor.actorId, operation: 'agent.unavailability.declare', key };
    if (await replayed(this.deps.planning, ref, hash)) return availabilityView(this.deps, actor.agent);
    const id = this.deps.ids.next();
    return this.write(actor.agent.id, async (tx, agent, now) => {
      const agenda = (await tx.agendas([agent.id], { start: slot.start, end: slot.end })).get(agent.id) ?? [];
      const decision = checkUnavailabilityDeclaration(slot, agenda, actor.bySupervisor, now);
      if (!decision.ok) throw refusal(decision.errors);
      const forced = decision.value.toUnassign;
      const released = await releaseAssignments(tx, await assignmentsByIds(tx, forced), {
        actorId: actor.actorId,
        by: actor.actorId,
        reason: RELEASE_REASON,
        cause: 'unavailability',
        at: now,
      });
      await tx.insertUnavailability({
        id,
        agentId: agent.id,
        kind: 'unavailable',
        start: slot.start,
        end: slot.end,
        reason: input.kind as (typeof KINDS)[number],
        note,
        forced: forced.length > 0,
        createdBy: actor.actorId,
        createdAt: now,
      });
      const trail = [
        ...released.audit,
        audit(actor.actorId, 'agent.unavailability_declared', 'agent', agent.id, now, {
          unavailabilityId: id,
        }),
      ];
      if (forced.length) {
        trail.push(
          audit(actor.actorId, 'agent.unavailability_forced', 'agent', agent.id, now, {
            unavailabilityId: id,
            assignments: forced,
          }),
        );
      }
      await tx.write({ events: released.events, audit: trail });
      await tx.remember({ ...ref, requestHash: hash, response: { unavailabilityId: id } });
    });
  }

  private async remove(actor: Actor, unavailabilityId: string): Promise<AvailabilityView> {
    return this.write(actor.agent.id, async (tx, agent, now) => {
      if (!(await tx.deleteUnavailability(agent.id, unavailabilityId)))
        throw cleaningErrors.unavailabilityNotFound();
      await tx.write({
        events: [],
        audit: [
          audit(actor.actorId, 'agent.unavailability_removed', 'agent', agent.id, now, { unavailabilityId }),
        ],
      });
    });
  }
}
