import { type BusyPeriod, overlaps, type Slot, slotFrom } from './schedule';

/**
 * Reprogrammation automatique au déblocage d'une mission (CDC Nettoyage, partie 10).
 * Algorithme simple et déterministe :
 * 1. les passages sont traités par date d'origine croissante (puis par identifiant) ;
 * 2. nouvelle date : la date d'origine si elle respecte encore le délai minimum, sinon la même
 *    heure, le même jour de la semaine, autant de semaines plus tard qu'il le faut ;
 * 3. agents : autant que dans le passage d'origine ; d'abord ses agents s'ils sont libres, puis
 *    les autres agents actifs par identifiant croissant, sans conflit avec leurs passages,
 *    leurs indisponibilités ou les passages déjà replacés ;
 * 4. faute d'agents libres en nombre suffisant, le passage est en échec (reprogrammation manuelle).
 */
export interface PassageToPlace {
  id: string;
  scheduledStart: Date;
  durationMinutes: number;
  agentIds: string[];
}

export interface PlacedPassage {
  originalId: string;
  start: Date;
  durationMinutes: number;
  agentIds: string[];
}

export interface ReschedulingPlan {
  placed: PlacedPassage[];
  failed: string[];
}

const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;

/** Date d'origine si elle reste possible, sinon décalée de semaines entières. */
export function targetStart(original: Date, now: Date, minimumLeadHours: number): Date {
  const earliest = now.getTime() + minimumLeadHours * HOUR_MS;
  if (original.getTime() >= earliest) return original;
  const weeks = Math.ceil((earliest - original.getTime()) / WEEK_MS);
  return new Date(original.getTime() + weeks * WEEK_MS);
}

function isFree(agentId: string, slot: Slot, busy: readonly BusyPeriod[]): boolean {
  return !busy.some((period) => period.agentId === agentId && overlaps(period.slot, slot));
}

export function planRescheduling(input: {
  passages: readonly PassageToPlace[];
  /** Agents actifs pouvant être affectés. */
  activeAgentIds: readonly string[];
  busy: readonly BusyPeriod[];
  now: Date;
  minimumLeadHours: number;
}): ReschedulingPlan {
  const busy: BusyPeriod[] = [...input.busy];
  const active = new Set(input.activeAgentIds);
  const others = [...active].sort();
  const passages = [...input.passages].sort(
    (a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime() || a.id.localeCompare(b.id),
  );
  const plan: ReschedulingPlan = { placed: [], failed: [] };

  for (const passage of passages) {
    const start = targetStart(passage.scheduledStart, input.now, input.minimumLeadHours);
    const slot = slotFrom(start, passage.durationMinutes);
    const needed = Math.max(1, new Set(passage.agentIds).size);
    const candidates = [...new Set([...passage.agentIds.filter((id) => active.has(id)), ...others])];
    const chosen: string[] = [];
    for (const agentId of candidates) {
      if (chosen.length === needed) break;
      if (isFree(agentId, slot, busy)) chosen.push(agentId);
    }
    if (chosen.length < needed) {
      plan.failed.push(passage.id);
      continue;
    }
    busy.push(...chosen.map((agentId) => ({ agentId, slot })));
    plan.placed.push({
      originalId: passage.id,
      start,
      durationMinutes: passage.durationMinutes,
      agentIds: chosen,
    });
  }
  return plan;
}
