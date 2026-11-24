import { effectiveAssignmentStatus, isInForce } from '../../domain/planning/assignment-status';
import { overlapMinutes, type Period } from '../../domain/planning/time';
import { type CleaningDeps } from '../deps';
import { requireStaff } from '../shared/access';
import { cleaningErrors } from '../shared/errors';
import { isOffsetCursor, page, type Page, period } from '../shared/input';
import { type TargetRecord } from './planning.ports';

/**
 * Planning du back-office (UC-NT-37, partie 9.6) : visites et séances d'une période, agents de
 * chacune, retard et urgence (R-PL-06), charge de chaque agent ; colonne « à affecter ».
 */

/** Période lue d'un coup : 62 jours au plus (contrat, à valider). */
export const MAX_PLANNING_DAYS = 62;
const DAY_MS = 86_400_000;
const URGENT_MS = 48 * 3_600_000;

export interface PlanningItemView {
  target: TargetRecord['target'];
  record: TargetRecord;
  agents: { agentId: string; name: string; isLead: boolean; status: string }[];
  /** Non démarrée à l'heure. */
  late: boolean;
  /** Sans équipe complète à moins de 48 h (R-PL-06). */
  urgent: boolean;
}

export interface AgentLoadView {
  agentId: string;
  name: string;
  plannedMinutes: number;
  maxMinutes: number;
}

export class PlanningViewUseCases {
  constructor(private readonly deps: CleaningDeps) {}

  async planning(input: {
    from: string;
    to: string;
    agentId?: string | null;
    teamId?: string | null;
    zoneKey?: string | null;
    programId?: string | null;
  }): Promise<{ from: Date; to: Date; items: PlanningItemView[]; loads: AgentLoadView[] }> {
    requireStaff();
    const window = period(input.from, input.to);
    if (window.end.getTime() - window.start.getTime() > MAX_PLANNING_DAYS * DAY_MS) {
      throw cleaningErrors.invalid('to', 'out_of_range');
    }
    const records = await this.deps.planning.planning({
      window,
      agentId: input.agentId || null,
      teamId: input.teamId || null,
      zoneKey: input.zoneKey || null,
      programId: input.programId || null,
    });
    const items = await this.items(records);
    return { from: window.start, to: window.end, items, loads: await this.loads(records, window) };
  }

  /** Colonne « à affecter », les plus proches d'abord (tri « urgency »). */
  async unassigned(input: {
    zoneKey?: string | null;
    limit?: number;
    cursor?: string;
  }): Promise<Page<PlanningItemView>> {
    requireStaff();
    const result = await this.deps.planning.unassigned(
      { zoneKey: input.zoneKey || null, now: this.deps.clock.now() },
      page(input.limit, input.cursor, isOffsetCursor),
    );
    return { ...result, items: await this.items(result.items) };
  }

  private async items(records: readonly TargetRecord[]): Promise<PlanningItemView[]> {
    const now = this.deps.clock.now();
    const agents = await this.deps.planning.agentsByIds([
      ...new Set(records.flatMap((r) => r.assignments.map((a) => a.agentId))),
    ]);
    const names = new Map(agents.map((a) => [a.id, a.displayName]));
    return [...records]
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .map((record) => {
        const assigned = record.assignments.filter((a) => isInForce(a, now));
        const open = ['to_assign', 'assigned', 'scheduled'].includes(record.status);
        return {
          target: record.target,
          record,
          agents: assigned.map((a) => ({
            agentId: a.agentId,
            name: names.get(a.agentId) ?? '',
            isLead: a.isLead,
            status: effectiveAssignmentStatus(a, now),
          })),
          late: open && record.start <= now,
          urgent:
            open &&
            record.start.getTime() - now.getTime() < URGENT_MS &&
            assigned.length < (record.expectedTeamSize ?? 1),
        };
      });
  }

  /**
   * Charge de chaque agent sur la période : heures prévues (la cible seule, sans le trajet), et
   * maximum = charge par jour × jours, sans dépasser la charge par semaine × semaines entamées.
   */
  private async loads(records: readonly TargetRecord[], window: Period): Promise<AgentLoadView[]> {
    const now = this.deps.clock.now();
    const planned = new Map<string, number>();
    for (const record of records) {
      for (const a of record.assignments.filter((x) => isInForce(x, now))) {
        planned.set(
          a.agentId,
          (planned.get(a.agentId) ?? 0) + overlapMinutes({ start: a.start, end: a.end }, window),
        );
      }
    }
    const days = Math.ceil((window.end.getTime() - window.start.getTime()) / DAY_MS);
    const agents = await this.deps.planning.agentsByIds([...planned.keys()]);
    return agents
      .map((agent) => ({
        agentId: agent.id,
        name: agent.displayName,
        plannedMinutes: Math.round(planned.get(agent.id) ?? 0),
        maxMinutes: Math.min(agent.maxHoursDay * days, agent.maxHoursWeek * Math.ceil(days / 7)) * 60,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
