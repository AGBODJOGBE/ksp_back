import { communeCoefficient, recommendedTeamSize, type ServiceDefinition } from './catalog';
import { applyCoefficient, roundToStep } from './money';

/**
 * Simulateur de prix (UC-CL-01, partie 4 du cahier des charges) :
 *
 *   prix = max(minimum, (quantité × prix unitaire + Σ options) × coefficient de la commune)
 *
 * La fourchette affichée va de −10 % à +15 % autour du prix calculé, arrondie à 500 FCFA.
 * Calcul local et pur : aucune donnée n'est enregistrée.
 */
export const RANGE_LOW_PERCENT = 90;
export const RANGE_HIGH_PERCENT = 115;
export const RANGE_ROUNDING_STEP = 500;

export interface PriceLine {
  label: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface SimulationInput {
  quantity: number;
  options: string[];
  commune: string;
  requestedTeamSize?: number;
}

export type Simulation =
  | {
      priced: true;
      computedPrice: number;
      low: number;
      high: number;
      breakdown: PriceLine[];
      minimumApplied: boolean;
      coefficientBp: number;
      recommendedTeamSize: number;
    }
  | {
      priced: false;
      /** Prix unitaire ou prix d'une option choisie pas encore fixé dans la grille. */
      reason: 'price_not_set' | 'option_price_not_set';
      recommendedTeamSize: number;
    };

/** Fourchette indicative autour d'un prix, arrondie à 500 FCFA. */
export function priceRange(price: number): { low: number; high: number } {
  return {
    low: roundToStep((price * RANGE_LOW_PERCENT) / 100, RANGE_ROUNDING_STEP),
    high: roundToStep((price * RANGE_HIGH_PERCENT) / 100, RANGE_ROUNDING_STEP),
  };
}

/** Options inconnues de la grille (à refuser avant tout calcul). */
export function unknownOptions(service: ServiceDefinition, options: string[]): string[] {
  const known = new Set(service.pricing.options.map((option) => option.code));
  return options.filter((code) => !known.has(code));
}

/** Lignes de prix d'un passage, tirées de la grille ; null si un prix manque. */
export function priceLines(
  service: ServiceDefinition,
  quantity: number,
  options: string[],
): PriceLine[] | null {
  const { unitPrice } = service.pricing;
  if (unitPrice === null) return null;
  const lines: PriceLine[] = [{ label: service.name, quantity, unitPrice, amount: quantity * unitPrice }];
  for (const code of new Set(options)) {
    const option = service.pricing.options.find((candidate) => candidate.code === code);
    if (!option || option.price === null) return null;
    lines.push({ label: option.label, quantity: 1, unitPrice: option.price, amount: option.price });
  }
  return lines;
}

export function simulate(service: ServiceDefinition, input: SimulationInput): Simulation {
  const teamSize = recommendedTeamSize(service.pricing.teamSize, input.quantity, input.requestedTeamSize);
  if (service.pricing.unitPrice === null) {
    return { priced: false, reason: 'price_not_set', recommendedTeamSize: teamSize };
  }
  const breakdown = priceLines(service, input.quantity, input.options);
  if (!breakdown) return { priced: false, reason: 'option_price_not_set', recommendedTeamSize: teamSize };

  const coefficientBp = communeCoefficient(service.pricing, input.commune);
  const subtotal = applyCoefficient(
    breakdown.reduce((sum, line) => sum + line.amount, 0),
    coefficientBp,
  );
  const minimum = service.pricing.minimumPrice ?? 0;
  const computedPrice = Math.max(minimum, subtotal);
  return {
    priced: true,
    computedPrice,
    ...priceRange(computedPrice),
    breakdown,
    minimumApplied: computedPrice > subtotal,
    coefficientBp,
    recommendedTeamSize: teamSize,
  };
}
