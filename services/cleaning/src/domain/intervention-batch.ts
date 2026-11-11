import { parseDay } from './intervention-schedule';
import { type BusyPeriod, conflictingAgents, type Slot } from './schedule';

/**
 * Planification en lot des dates restantes d'un plan de passages (ADR-052) : un passage par date,
 * mêmes agents, même heure et même durée, contrôlés date par date comme un passage seul.
 */
export interface BatchSelection {
  /** Sous-ensemble des dates restantes ; absent ou vide : selon `until`. */
  dates?: string[] | undefined;
  /** Toutes les dates restantes jusqu'à cette date incluse ; absente : toutes. */
  until?: string | null | undefined;
}

export interface BatchProblem {
  field: string;
  message: string;
}

/** Dates retenues, triées et sans doublon, ou le défaut de la sélection. */
export function selectBatchDates(
  remaining: readonly string[],
  selection: BatchSelection,
): { dates: string[] } | { problem: BatchProblem } {
  const wanted = selection.dates ?? [];
  if (wanted.length && selection.until) {
    return { problem: { field: 'until', message: 'Envoyez dates ou until, pas les deux.' } };
  }
  if (wanted.length) {
    for (const [index, date] of wanted.entries()) {
      if (!remaining.includes(date)) {
        return {
          problem: {
            field: `dates[${index}]`,
            message: `Le ${date} n'est pas une date restante du plan de passages.`,
          },
        };
      }
    }
    return { dates: [...new Set(wanted)].sort() };
  }
  if (selection.until) {
    if (parseDay(selection.until) === null) {
      return { problem: { field: 'until', message: 'Date attendue au format AAAA-MM-JJ.' } };
    }
    const until = selection.until;
    const dates = remaining.filter((date) => date <= until);
    if (!dates.length) {
      return { problem: { field: 'until', message: `Aucune date restante jusqu'au ${until}.` } };
    }
    return { dates };
  }
  return { dates: [...remaining] };
}

export interface BatchSlot {
  date: string;
  slot: Slot;
}

export interface BatchConflict {
  date: string;
  /** Agents déjà pris ou indisponibles sur le créneau de cette date. */
  agentIds: string[];
}

/**
 * Créneaux libres et dates en conflit, dans l'ordre : chaque créneau est contrôlé contre l'agenda
 * des agents (passages actifs, indisponibilités ; un passage d'une mission du même groupe n'est pas
 * un conflit, ADR-035) et contre les créneaux du lot déjà retenus.
 */
export function planBatch(
  slots: readonly BatchSlot[],
  agentIds: readonly string[],
  busy: readonly BusyPeriod[],
  groupId: string | null,
): { free: BatchSlot[]; conflicts: BatchConflict[] } {
  const agenda: BusyPeriod[] = [...busy];
  const free: BatchSlot[] = [];
  const conflicts: BatchConflict[] = [];
  for (const candidate of slots) {
    const taken = conflictingAgents([...agentIds], candidate.slot, agenda, groupId);
    if (taken.length) {
      conflicts.push({ date: candidate.date, agentIds: taken });
      continue;
    }
    free.push(candidate);
    for (const agentId of agentIds) agenda.push({ agentId, slot: candidate.slot, groupId: null });
  }
  return { free, conflicts };
}
