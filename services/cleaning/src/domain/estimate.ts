import { type PriceCalculation } from './simulator';

/**
 * Estimation de plusieurs prestations d'un même lieu (ADR-034) : chaque prestation est calculée
 * par le simulateur de l'ADR-033, puis les prix sont additionnés. Le total n'existe que si toutes
 * les prestations ont un prix.
 */
export type EstimateStatus = 'priced' | 'partially_priced' | 'unpriced';

export interface EstimateTotal {
  status: EstimateStatus;
  /** Somme des prix (entiers XOF), null si une prestation n'a pas de prix. */
  total: number | null;
}

/** Nombre maximal de prestations d'une estimation ou d'un groupe de demandes. */
export const MAX_GROUP_ITEMS = 10;

export function aggregateEstimates(
  calculations: readonly Pick<PriceCalculation, 'priced' | 'computedPrice'>[],
): EstimateTotal {
  const priced = calculations.filter(
    (calculation) => calculation.priced && calculation.computedPrice !== null,
  );
  if (calculations.length > 0 && priced.length === calculations.length) {
    return {
      status: 'priced',
      total: priced.reduce((sum, calculation) => sum + (calculation.computedPrice as number), 0),
    };
  }
  return { status: priced.length ? 'partially_priced' : 'unpriced', total: null };
}
