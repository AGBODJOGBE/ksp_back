import { type PlanningTarget } from './assignment-check';

/**
 * Ordres communs à la planification manuelle et automatique : identifiants comparés par points de
 * code (le résultat ne dépend pas de la langue de l'hôte), cibles dans l'ordre chronologique.
 */

/** Comparaison d'identifiants par points de code, indépendante de la langue de l'hôte. */
export function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Ordre de contrôle des cibles (R-PL-11) : début, puis type, puis identifiant. Le même pour
 * l'affectation en lot, la planification automatique et la validation des propositions.
 */
export function comparePlanningOrder(
  a: Pick<PlanningTarget, 'start' | 'target'>,
  b: Pick<PlanningTarget, 'start' | 'target'>,
): number {
  return (
    a.start.getTime() - b.start.getTime() ||
    compareIds(a.target.kind, b.target.kind) ||
    compareIds(a.target.id, b.target.id)
  );
}
