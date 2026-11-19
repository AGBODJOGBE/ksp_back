import { type FrequencyCoefficient, type FrequencyKey } from './types';

/**
 * Remise récurrente (R-PX-06) : la clé de fréquence d'un programme choisit le coefficient du tarif.
 * Hebdomadaire chaque semaine → `weekly`, toutes les N semaines (N ≥ 2) → `every_N_weeks`, mensuel
 * → `monthly`. Programme ponctuel ou absent : aucune clé, coefficient neutre.
 */
export interface FrequencySource {
  kind: 'one_off' | 'weekly' | 'monthly';
  /** Hebdomadaire : toutes les N semaines ; absent : chaque semaine. */
  everyWeeks: number | null;
}

export function frequencyKeyOf(plan: FrequencySource | null): FrequencyKey | null {
  if (plan === null || plan.kind === 'one_off') return null;
  if (plan.kind === 'monthly') return 'monthly';
  const every = plan.everyWeeks ?? 1;
  return every === 1 ? 'weekly' : `every_${every}_weeks`;
}

/** Coefficient de la clé ; null sans clé ou sans entrée correspondante (aucune ligne de remise). */
export function frequencyCoefficientFor(
  coefficients: readonly FrequencyCoefficient[],
  key: FrequencyKey | null,
): number | null {
  if (key === null) return null;
  return coefficients.find((entry) => entry.key === key)?.coefficientBps ?? null;
}
