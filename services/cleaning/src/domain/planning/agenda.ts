import { type AssignmentState, isInForce } from './assignment-status';
import { compareIds } from './order';
import { addMinutes, overlaps, type Period } from './time';

/**
 * Agenda d'un agent et contrôle « Aucun conflit » (9.4) : pas d'autre visite ni séance sur la
 * période, temps de trajet compris (R-ZN-02, R-VI-02). La base porte le même contrôle
 * (assignments_no_overlap) sur la période occupée [début − trajet, fin) des affectations en vigueur ;
 * le domaine donne la même réponse avant d'écrire.
 */
export interface TargetRef {
  kind: 'visit' | 'session';
  id: string;
}

/** Affectation de l'agenda, telle qu'enregistrée. */
export interface AgendaEntry extends AssignmentState {
  assignmentId: string;
  target: TargetRef;
  placeId: string;
  /** Début de la cible. */
  start: Date;
  /** Fin de la période occupée (fin réelle pour une cible terminée, R-PL-09). */
  end: Date;
  /** Trajet enregistré avant la cible. */
  travelMinutes: number;
}

/** Cible à contrôler : où et quand l'agent doit être. */
export interface AgendaCandidate {
  target: TargetRef;
  placeId: string;
  start: Date;
  end: Date;
}

export interface ScheduleConflict {
  assignmentId: string;
  target: TargetRef;
  start: Date;
  end: Date;
  /** Trajet compté entre les deux cibles ; 0 pour un recouvrement direct. */
  travelMinutes: number;
}

/**
 * Temps de trajet en voiture entre deux lieux, en minutes (OSRM via geo, fourni par l'appelant) ;
 * null quand le calcul est indisponible.
 */
export type TravelTime = (fromPlaceId: string, toPlaceId: string) => number | null;

/** Trajets lus dans une matrice déjà calculée ; un couple absent vaut « indisponible ». */
export function travelFromMatrix(
  matrix: Readonly<Record<string, Readonly<Record<string, number>>>>,
): TravelTime {
  return (from, to) => matrix[from]?.[to] ?? null;
}

/**
 * R-ZN-02 : 0 sans affectation précédente, 0 sans calcul au même lieu, sinon le temps calculé, ou
 * la valeur par défaut des réglages si le calcul est indisponible.
 */
export function travelMinutes(
  fromPlaceId: string | null,
  toPlaceId: string,
  travel: TravelTime,
  defaultMinutes: number,
): number {
  if (fromPlaceId === null || fromPlaceId === toPlaceId) return 0;
  return travel(fromPlaceId, toPlaceId) ?? defaultMinutes;
}

/** Période occupée d'une affectation : début moins le trajet, jusqu'à la fin. */
export function occupiedPeriod(entry: Pick<AgendaEntry, 'start' | 'end' | 'travelMinutes'>): Period {
  return { start: addMinutes(entry.start, -entry.travelMinutes), end: entry.end };
}

function sameTarget(a: TargetRef, b: TargetRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/**
 * Conflits d'une cible avec l'agenda de l'agent :
 * - trajet avant la cible : depuis l'affectation précédente (celle qui finit le plus tard avant son
 *   début ; à égalité, le trajet le plus long) ;
 * - une affectation précédente ou en recouvrement est en conflit si sa période occupée chevauche
 *   [début − trajet, fin) ;
 * - une affectation suivante l'est si l'agent ne peut pas la rejoindre à temps (voir
 *   travelNeededBefore).
 */
export function scheduleConflicts(
  candidate: AgendaCandidate,
  agenda: readonly AgendaEntry[],
  travel: TravelTime,
  defaultTravelMinutes: number,
  now: Date,
): { travelMinutes: number; occupied: Period; conflicts: ScheduleConflict[] } {
  const entries = agenda.filter(
    (entry) => isInForce(entry, now) && !sameTarget(entry.target, candidate.target),
  );
  const before = entries.filter((entry) => entry.end <= candidate.start);
  const lastEnd = Math.max(...before.map((entry) => entry.end.getTime()));
  const travelBefore = Math.max(
    0,
    ...before
      .filter((entry) => entry.end.getTime() === lastEnd)
      .map((entry) => travelMinutes(entry.placeId, candidate.placeId, travel, defaultTravelMinutes)),
  );
  const occupied = { start: addMinutes(candidate.start, -travelBefore), end: candidate.end };

  const conflicts: ScheduleConflict[] = [];
  for (const entry of entries) {
    const conflict = (counted: number) =>
      conflicts.push({
        assignmentId: entry.assignmentId,
        target: entry.target,
        start: entry.start,
        end: entry.end,
        travelMinutes: counted,
      });
    if (entry.start >= candidate.end) {
      const needed = travelNeededBefore(entry, candidate.placeId, travel, defaultTravelMinutes);
      if (addMinutes(candidate.end, needed) > entry.start) conflict(needed);
    } else if (entry.end <= candidate.start) {
      if (overlaps(occupied, occupiedPeriod(entry))) conflict(travelBefore);
    } else {
      conflict(0);
    }
  }
  conflicts.sort(
    (a, b) => a.start.getTime() - b.start.getTime() || compareIds(a.assignmentId, b.assignmentId),
  );
  return { travelMinutes: travelBefore, occupied, conflicts };
}

/**
 * Battement exigé avant une affectation qui suit la cible : le trajet réel depuis le lieu de la
 * cible (R-ZN-02), et au moins le trajet déjà enregistré pour cette affectation, que la base compte
 * encore dans sa période occupée (assignments_no_overlap). Interprétation prudente : le plus long des
 * deux.
 */
export function travelNeededBefore(
  next: Pick<AgendaEntry, 'placeId' | 'travelMinutes'>,
  fromPlaceId: string,
  travel: TravelTime,
  defaultTravelMinutes: number,
): number {
  return Math.max(next.travelMinutes, travelMinutes(fromPlaceId, next.placeId, travel, defaultTravelMinutes));
}
