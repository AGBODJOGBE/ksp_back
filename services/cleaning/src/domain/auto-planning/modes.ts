import { type PlanningTarget } from '../planning/assignment-check';
import { accepted, type Decision, planningError, refused } from '../planning/errors';
import { addMinutes, type Period } from '../planning/time';
import { compareIds } from './score';

/**
 * Modes de la planification automatique (R-PL-05), période d'un passage (R-PL-01) et cibles
 * retenues. Les déclencheurs de R-PL-01 (acceptation d'un devis, passage de nuit, désaffectation,
 * indisponibilité ou désactivation d'un agent, reprise d'un programme, bouton du superviseur) sont
 * portés par l'adaptateur : tous lancent le même passage, borné par cette période et ces filtres.
 */
export type PlanningMode = 'manual' | 'proposal' | 'automatic';

/** Mode général par défaut (R-PL-05, CleaningSettings.defaultPlanningMode). */
export const DEFAULT_PLANNING_MODE: PlanningMode = 'proposal';

/** Horizon par défaut du passage (R-PL-01, CleaningSettings.planningHorizonDays). */
export const DEFAULT_HORIZON_DAYS = 14;

/** Séance à planifier : cible de la planification, rattachée à son programme. */
export interface AutoTarget extends PlanningTarget {
  programId: string;
}

/** Réglage général et modes des zones (Zone.planningMode ; null : réglage général). */
export interface ZoneModes {
  defaultMode: PlanningMode;
  byZone: Readonly<Record<string, PlanningMode | null>>;
}

/**
 * Mode appliqué à une cible : celui de sa zone, sinon le réglage général. Interprétation : la zone
 * d'une cible est la commune de son lieu (Zone.commune_key).
 */
export function effectiveMode(communeKey: string, modes: ZoneModes): PlanningMode {
  return modes.byZone[communeKey] ?? modes.defaultMode;
}

/**
 * Période d'un passage (RunAutoPlanning.from, to) : début par défaut maintenant ; fin par défaut le
 * début plus l'horizon des réglages. Interprétation : l'horizon court depuis le début demandé, pour
 * qu'un début fourni seul donne toujours une période complète.
 */
export function planningWindow(input: {
  now: Date;
  from: Date | null;
  to: Date | null;
  horizonDays: number;
}): Decision<Period> {
  const start = input.from ?? input.now;
  const end = input.to ?? addMinutes(start, input.horizonDays * 24 * 60);
  if (end <= start) {
    return refused(planningError('CLEANING_VALIDATION_FAILED', { field: 'to', reason: 'not_after_from' }));
  }
  return accepted({ start, end });
}

/**
 * Cible de l'automatique : une séance « à affecter » (9.5 ; une séance sans équipe complète le
 * reste, R-PL-06) dont le début n'est pas passé (R-PL-10 ; un début égal à maintenant est passé,
 * comme targetPreconditions). Les visites et les séances planifiées ne sont jamais touchées
 * (R-PL-07).
 */
export function isAutoPlannable(target: PlanningTarget, now: Date): boolean {
  return target.target.kind === 'session' && target.status === 'to_assign' && target.start > now;
}

/** Ordre de traitement : début, puis type, puis identifiant (le même que l'affectation en lot, R-PL-11). */
export function comparePlanningOrder(a: PlanningTarget, b: PlanningTarget): number {
  return (
    a.start.getTime() - b.start.getTime() ||
    compareIds(a.target.kind, b.target.kind) ||
    compareIds(a.target.id, b.target.id)
  );
}

export interface TargetScope {
  /** Période semi-ouverte : une séance compte si son début y tombe. */
  window: Period;
  now: Date;
  /** Filtre de zone (commune du lieu) ; null : toutes. */
  zoneKey: string | null;
  programId: string | null;
}

/** Cibles d'un passage, avec leur mode, dans l'ordre de traitement ; les zones en mode manuel sont exclues. */
export function selectTargets(
  targets: readonly AutoTarget[],
  scope: TargetScope,
  modes: ZoneModes,
): { target: AutoTarget; mode: Exclude<PlanningMode, 'manual'> }[] {
  const selected: { target: AutoTarget; mode: Exclude<PlanningMode, 'manual'> }[] = [];
  for (const target of [...targets].sort(comparePlanningOrder)) {
    const mode = effectiveMode(target.communeKey, modes);
    if (mode === 'manual' || !isAutoPlannable(target, scope.now)) continue;
    if (target.start < scope.window.start || target.start >= scope.window.end) continue;
    if (scope.zoneKey !== null && target.communeKey !== scope.zoneKey) continue;
    if (scope.programId !== null && target.programId !== scope.programId) continue;
    selected.push({ target, mode });
  }
  return selected;
}
