/** Créneaux horaires et conflits d'agenda (UC-CL-09). Début inclus, fin exclue. */
export interface Slot {
  start: Date;
  end: Date;
}

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

export function isValidSlot(slot: Slot): boolean {
  return !Number.isNaN(slot.start.getTime()) && !Number.isNaN(slot.end.getTime()) && slot.end > slot.start;
}

export function overlaps(a: Slot, b: Slot): boolean {
  return a.start < b.end && b.start < a.end;
}

export function slotFrom(start: Date, durationMinutes: number): Slot {
  return { start, end: new Date(start.getTime() + durationMinutes * MINUTE_MS) };
}

/** Délai minimum avant une mission (48 heures par défaut). */
export function respectsLeadTime(start: Date, now: Date, minimumLeadHours: number): boolean {
  return start.getTime() - now.getTime() >= minimumLeadHours * HOUR_MS;
}

/** Annulation sans frais jusqu'à N heures avant le début (24 heures par défaut). */
export function isFreeCancellation(start: Date | null, now: Date, freeCancellationHours: number): boolean {
  return start === null || start.getTime() - now.getTime() >= freeCancellationHours * HOUR_MS;
}

export interface BusyPeriod {
  agentId: string;
  slot: Slot;
}

/**
 * Agents déjà pris sur le créneau : un autre passage ou une indisponibilité déclarée.
 * Renvoie les agents en conflit, sans doublon, dans l'ordre demandé.
 */
export function conflictingAgents(agentIds: string[], slot: Slot, busy: BusyPeriod[]): string[] {
  const taken = new Set(busy.filter((period) => overlaps(period.slot, slot)).map((period) => period.agentId));
  return [...new Set(agentIds)].filter((agentId) => taken.has(agentId));
}
