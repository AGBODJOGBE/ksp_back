import { type Answers, type FormAnswers } from './answers';
import {
  communeCoefficient,
  effectIsSet,
  type FormField,
  normalizeCommune,
  recommendedTeamSize,
  type ServiceDefinition,
  teamSizeField,
} from './catalog';
import { BASIS_POINTS, roundToStep } from './money';

/**
 * Calcul du prix d'un passage (UC-CL-01, ADR-033), pur et sans enregistrement :
 *
 *   prix = max(minimum, (Σ lignes de la prestation + Σ options [Σ lignes de l'option × Π coefficients
 *          de ses champs]) × Π coefficients des champs de la prestation × commune × fréquence)
 *
 * Lignes : nombre × prix par unité, supplément d'une valeur choisie ou d'une réponse oui, forfait
 * d'une option. Le produit des coefficients est appliqué une seule fois, en calcul entier exact,
 * puis arrondi au franc le plus proche. Fourchette affichée : −10 % / +15 %, arrondie à 500 FCFA.
 *
 * Prix non fixé (null) mais nécessaire : `priced: false` avec la raison et la liste des prix
 * manquants ; 0 (ou 10 000 points de base) : sans effet.
 */
export const RANGE_LOW_PERCENT = 90;
export const RANGE_HIGH_PERCENT = 115;
export const RANGE_ROUNDING_STEP = 500;

/** Ligne d'un devis (lignes modifiables par le superviseur). */
export interface PriceLine {
  label: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export type CalculationLineKind = 'unit_price' | 'supplement' | 'flat_price';

export interface CalculationLine extends PriceLine {
  kind: CalculationLineKind;
  optionCode: string | null;
  fieldCode: string | null;
  choiceCode: string | null;
  unitLabel: string | null;
}

export type CoefficientSource = 'choice' | 'boolean' | 'commune' | 'frequency';

export interface AppliedCoefficient {
  source: CoefficientSource;
  /** Option dont le champ porte le coefficient : il ne s'applique qu'à elle. */
  optionCode: string | null;
  fieldCode: string | null;
  code: string | null;
  label: string;
  coefficientBp: number;
}

export interface MissingPrice {
  optionCode: string | null;
  fieldCode: string | null;
  choiceCode: string | null;
}

export type PricingReason = 'price_not_set' | 'option_price_not_set' | 'answers_incomplete';

export interface PriceCalculation {
  /** Version de la grille, null pour une définition essayée sans être enregistrée. */
  pricingVersion: number | null;
  priced: boolean;
  reason: PricingReason | null;
  missingPrices: MissingPrice[];
  lines: CalculationLine[];
  baseAmount: number | null;
  coefficients: AppliedCoefficient[];
  subtotal: number | null;
  minimumPrice: number | null;
  minimumApplied: boolean;
  computedPrice: number | null;
  estimate: { low: number; high: number } | null;
  recommendedTeamSize: number;
}

export interface CalculationInput extends FormAnswers {
  commune: string;
  requestedTeamSize?: number;
  /** Ancien format converti sans toutes les réponses obligatoires. */
  incomplete?: boolean;
}

/** Fourchette indicative autour d'un prix, arrondie à 500 FCFA. */
export function priceRange(price: number): { low: number; high: number } {
  return {
    low: roundToStep((price * RANGE_LOW_PERCENT) / 100, RANGE_ROUNDING_STEP),
    high: roundToStep((price * RANGE_HIGH_PERCENT) / 100, RANGE_ROUNDING_STEP),
  };
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

interface Part {
  lines: CalculationLine[];
  coefficients: AppliedCoefficient[];
  missing: MissingPrice[];
}

/** Lignes, coefficients et prix manquants des réponses à une liste de champs. */
function priceFields(fields: FormField[], answers: Answers, optionCode: string | null, prefix: string): Part {
  const part: Part = { lines: [], coefficients: [], missing: [] };
  const label = (field: FormField) => (prefix ? `${prefix} — ${lowerFirst(field.label)}` : field.label);
  for (const field of fields) {
    if (!field.active) continue;
    const value = answers[field.code];
    if (field.type === 'number' && typeof value === 'number' && value > 0) {
      if (field.pricePerUnit === null) {
        part.missing.push({ optionCode, fieldCode: field.code, choiceCode: null });
      } else if (field.pricePerUnit > 0) {
        part.lines.push({
          kind: 'unit_price',
          optionCode,
          fieldCode: field.code,
          choiceCode: null,
          label: label(field),
          quantity: value,
          unitLabel: field.unitLabel,
          unitPrice: field.pricePerUnit,
          amount: value * field.pricePerUnit,
        });
      }
    }
    if (field.type === 'choice' && typeof value === 'string') {
      const choice = field.choices.find((candidate) => candidate.code === value);
      if (!choice) continue;
      const text = `${label(field)} : ${lowerFirst(choice.label)}`;
      if (!effectIsSet(choice.supplement, choice.coefficientBp)) {
        part.missing.push({ optionCode, fieldCode: field.code, choiceCode: choice.code });
        continue;
      }
      if (choice.supplement) {
        part.lines.push({
          kind: 'supplement',
          optionCode,
          fieldCode: field.code,
          choiceCode: choice.code,
          label: text,
          quantity: 1,
          unitLabel: null,
          unitPrice: choice.supplement,
          amount: choice.supplement,
        });
      }
      if (choice.coefficientBp !== null) {
        part.coefficients.push({
          source: 'choice',
          optionCode,
          fieldCode: field.code,
          code: choice.code,
          label: text,
          coefficientBp: choice.coefficientBp,
        });
      }
    }
    if (field.type === 'boolean' && value === true) {
      const text = `${label(field)} : oui`;
      if (!effectIsSet(field.supplementIfYes, field.coefficientBpIfYes)) {
        part.missing.push({ optionCode, fieldCode: field.code, choiceCode: null });
        continue;
      }
      if (field.supplementIfYes) {
        part.lines.push({
          kind: 'supplement',
          optionCode,
          fieldCode: field.code,
          choiceCode: null,
          label: text,
          quantity: 1,
          unitLabel: null,
          unitPrice: field.supplementIfYes,
          amount: field.supplementIfYes,
        });
      }
      if (field.coefficientBpIfYes !== null) {
        part.coefficients.push({
          source: 'boolean',
          optionCode,
          fieldCode: field.code,
          code: null,
          label: text,
          coefficientBp: field.coefficientBpIfYes,
        });
      }
    }
  }
  return part;
}

const sum = (lines: { amount: number }[]) => lines.reduce((total, line) => total + line.amount, 0);

/**
 * Montant exact × produit de coefficients (points de base), arrondi au franc le plus proche
 * (moitié vers le haut) : tous les montants et coefficients sont positifs.
 */
function scaled(groups: { amount: number; coefficients: number[] }[], global: number[]): number {
  const depth = Math.max(0, ...groups.map((group) => group.coefficients.length));
  const bp = BigInt(BASIS_POINTS);
  let numerator = 0n;
  for (const group of groups) {
    let value = BigInt(group.amount);
    for (const coefficient of group.coefficients) value *= BigInt(coefficient);
    numerator += value * bp ** BigInt(depth - group.coefficients.length);
  }
  for (const coefficient of global) numerator *= BigInt(coefficient);
  const denominator = bp ** BigInt(depth + global.length);
  return Number((numerator * 2n + denominator) / (denominator * 2n));
}

/** Calcul d'un passage avec des réponses déjà validées (`checkAnswers`). */
export function calculatePrice(
  service: ServiceDefinition,
  input: CalculationInput,
  pricingVersion: number | null = service.pricing.version,
): PriceCalculation {
  const { pricing } = service;
  const quantityField = teamSizeField(service);
  const quantity = quantityField ? input.answers[quantityField.code] : undefined;
  const teamSize = recommendedTeamSize(
    pricing.teamSize,
    typeof quantity === 'number' ? quantity : 0,
    input.requestedTeamSize,
  );

  const own = priceFields(service.fields, input.answers, null, '');
  const lines = [...own.lines];
  const coefficients = [...own.coefficients];
  const ownMissing = own.missing;
  const optionMissing: MissingPrice[] = [];
  const groups: { amount: number; coefficients: number[] }[] = [];
  for (const selection of input.options) {
    const option = service.options.find((candidate) => candidate.code === selection.code);
    if (!option) continue;
    const part = priceFields(option.fields, selection.answers, option.code, option.label);
    const optionLines: CalculationLine[] = [];
    if (option.flatPrice === null && !option.fields.some((field) => field.active)) {
      optionMissing.push({ optionCode: option.code, fieldCode: null, choiceCode: null });
    } else if (option.flatPrice) {
      optionLines.push({
        kind: 'flat_price',
        optionCode: option.code,
        fieldCode: null,
        choiceCode: null,
        label: option.label,
        quantity: 1,
        unitLabel: null,
        unitPrice: option.flatPrice,
        amount: option.flatPrice,
      });
    }
    optionLines.push(...part.lines);
    optionMissing.push(...part.missing);
    lines.push(...optionLines);
    coefficients.push(...part.coefficients);
    groups.push({ amount: sum(optionLines), coefficients: part.coefficients.map((c) => c.coefficientBp) });
  }

  const communeBp = communeCoefficient(pricing, input.commune);
  coefficients.push({
    source: 'commune',
    optionCode: null,
    fieldCode: null,
    code: normalizeCommune(input.commune),
    label: input.commune.trim(),
    coefficientBp: communeBp,
  });
  const frequency = pricing.frequencies.find((candidate) => candidate.code === input.frequency);
  if (frequency) {
    coefficients.push({
      source: 'frequency',
      optionCode: null,
      fieldCode: null,
      code: frequency.code,
      label: frequency.label,
      coefficientBp: frequency.coefficientBp,
    });
  }

  const missingPrices = [...ownMissing, ...optionMissing];
  const reason = input.incomplete
    ? 'answers_incomplete'
    : ownMissing.length
      ? 'price_not_set'
      : optionMissing.length
        ? 'option_price_not_set'
        : null;
  const base = {
    pricingVersion,
    missingPrices,
    lines,
    coefficients,
    minimumPrice: pricing.minimumPrice,
    recommendedTeamSize: teamSize,
  };
  if (reason) {
    return {
      ...base,
      priced: false,
      reason,
      baseAmount: null,
      subtotal: null,
      minimumApplied: false,
      computedPrice: null,
      estimate: null,
    };
  }
  const global = coefficients.filter((c) => c.optionCode === null).map((c) => c.coefficientBp);
  const subtotal = scaled([{ amount: sum(own.lines), coefficients: [] }, ...groups], global);
  const computedPrice = Math.max(pricing.minimumPrice ?? 0, subtotal);
  return {
    ...base,
    priced: true,
    reason: null,
    baseAmount: sum(lines),
    subtotal,
    minimumApplied: computedPrice > subtotal,
    computedPrice,
    estimate: priceRange(computedPrice),
  };
}

/**
 * Lignes d'un devis préremplies depuis un calcul : ses lignes, puis une ligne d'ajustement pour
 * l'écart dû aux coefficients ou au minimum de commande. Null si le calcul n'a pas de prix.
 */
export function quoteLinesFrom(calculation: PriceCalculation): PriceLine[] | null {
  if (!calculation.priced || calculation.computedPrice === null) return null;
  const lines: PriceLine[] = calculation.lines.map(({ label, quantity, unitPrice, amount }) => ({
    label,
    quantity,
    unitPrice,
    amount,
  }));
  const adjustment = calculation.computedPrice - sum(lines);
  if (adjustment === 0) return lines;
  const label = calculation.minimumApplied
    ? 'Minimum de commande'
    : `Ajustement : ${calculation.coefficients
        .filter((c) => c.coefficientBp !== BASIS_POINTS)
        .map((c) => c.label)
        .join(', ')}`;
  return [...lines, { label, quantity: 1, unitPrice: adjustment, amount: adjustment }];
}
