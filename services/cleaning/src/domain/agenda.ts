import { overlaps, type Slot, slotFrom } from './schedule';

/**
 * Agenda d'un agent (ADR-053) : ses passages actifs et ses visites techniques planifiées (demande
 * encore ouverte). Une visite occupe la durée réglée d'une visite à partir de son heure prévue.
 */
export interface Assignment {
  kind: 'intervention' | 'visit';
  /** Passage ou visite. */
  id: string;
  /** Mission du passage, null pour une visite. */
  missionId: string | null;
  /** Demande de la visite, null pour un passage. */
  requestId: string | null;
  slot: Slot;
}

export function visitSlot(scheduledAt: Date, visitDurationMinutes: number): Slot {
  return slotFrom(scheduledAt, visitDurationMinutes);
}

/** Affectations qui chevauchent la période, dans l'ordre chronologique. */
export function overlappingAssignments(assignments: readonly Assignment[], period: Slot): Assignment[] {
  return chronological(assignments.filter((assignment) => overlaps(assignment.slot, period)));
}

/** Affectations pas encore terminées (en cours ou à venir), dans l'ordre chronologique. */
export function upcomingAssignments(assignments: readonly Assignment[], now: Date): Assignment[] {
  return chronological(assignments.filter((assignment) => assignment.slot.end > now));
}

function chronological(assignments: Assignment[]): Assignment[] {
  return [...assignments].sort(
    (a, b) => a.slot.start.getTime() - b.slot.start.getTime() || a.id.localeCompare(b.id),
  );
}
