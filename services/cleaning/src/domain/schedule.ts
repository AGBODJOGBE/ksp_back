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

/**
 * Fuseau des dates du Nettoyage : le Bénin (Africa/Porto-Novo, UTC+1 sans heure d'été). Réglable
 * par la configuration du service (CLEANING_TIME_ZONE).
 */
export const DEFAULT_TIME_ZONE = 'Africa/Porto-Novo';

/** Jour civil d'une date dans le fuseau donné, au format AAAA-MM-JJ (comparable comme une chaîne). */
export function localDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Contrôles de dates du terrain (proposition du 2026-10-28, à valider). Chaque règle se désactive
 * par configuration, sans changer le code.
 */
export interface FieldDatePolicy {
  /** Refuser de démarrer un passage avant le jour prévu (dans le fuseau). */
  blockEarlyInterventionStart: boolean;
  /** Refuser le compte rendu d'une visite avant l'heure prévue de la visite. */
  blockEarlyVisitReport: boolean;
  timeZone: string;
}

export const DEFAULT_FIELD_DATE_POLICY: FieldDatePolicy = {
  blockEarlyInterventionStart: true,
  blockEarlyVisitReport: true,
  timeZone: DEFAULT_TIME_ZONE,
};

/** Passage démarré avant son jour prévu : le jour même reste permis, à toute heure. */
export function isBeforeScheduledDay(now: Date, scheduledStart: Date, timeZone: string): boolean {
  return localDay(now, timeZone) < localDay(scheduledStart, timeZone);
}

/** Compte rendu d'une visite avant son heure prévue. */
export function isBeforeScheduledTime(now: Date, scheduledAt: Date): boolean {
  return now.getTime() < scheduledAt.getTime();
}

/** « 5 novembre 2026 » dans le fuseau donné. */
export function formatDayFr(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

/** « 5 novembre 2026 à 09:30 » dans le fuseau donné. */
export function formatDateTimeFr(date: Date, timeZone: string): string {
  const time = new Intl.DateTimeFormat('fr-FR', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  return `${formatDayFr(date, timeZone)} à ${time}`;
}
