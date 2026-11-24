import { isAmount, isCoefficientBps } from './money';
import { type ParameterDefinition, type Tariff, type TariffSupplement } from './types';

/**
 * Cohérence d'un tarif à l'enregistrement du brouillon et à la publication (R-CA-04, R-CA-07,
 * R-CA-08, R-CA-11, R-PX-06). Deux familles de défauts, dans l'ordre où ils sont trouvés :
 * - `CLEANING_TARIFF_INCOMPLETE` : raison de la liste fermée de R-CA-11 et rang de l'élément ;
 * - `CLEANING_VALIDATION_FAILED` : champ et raison (`required`, `out_of_range`, `not_applicable`,
 *   `invalid_type`, `duplicate`).
 */
export type TariffDraft = Omit<Tariff, 'version' | 'status'>;
export type TariffStage = 'draft' | 'publish';

export interface TariffContext {
  /** Paramètres demandés par le lieu et par l'offre, actifs ou non. */
  askedParameters: readonly ParameterDefinition[];
  /** Le type de l'offre est un pack (R-CA-04). */
  isPack: boolean;
}

export type TariffIncompleteReason =
  | 'brackets_overlap'
  | 'brackets_gap'
  | 'first_bracket_above_min'
  | 'base_not_number'
  | 'base_inactive'
  | 'base_not_asked'
  | 'supplement_parameter_not_asked'
  | 'unknown_choice'
  | 'mode_incompatible';

export type TariffValidationReason =
  'required' | 'out_of_range' | 'not_applicable' | 'invalid_type' | 'duplicate';

export type TariffProblem =
  | { code: 'CLEANING_TARIFF_INCOMPLETE'; reason: TariffIncompleteReason; index: number | null }
  | { code: 'CLEANING_VALIDATION_FAILED'; field: string; reason: TariffValidationReason };

/** Remise d'un pack : 0 à 90 % (R-CA-04). */
export const MAX_PACK_DISCOUNT_BPS = 9000;
/** Valeur d'un paramètre nombre : entier de 0 à 1 000 000 (R-PX-03). */
export const MAX_NUMBER_VALUE = 1_000_000;

const FREQUENCY_KEY = /^(weekly|monthly|every_([2-9]|1[0-2])_weeks)$/;

const incomplete = (reason: TariffIncompleteReason, index: number | null): TariffProblem => ({
  code: 'CLEANING_TARIFF_INCOMPLETE',
  reason,
  index,
});
const invalid = (field: string, reason: TariffValidationReason): TariffProblem => ({
  code: 'CLEANING_VALIDATION_FAILED',
  field,
  reason,
});

const isNumberValue = (value: number) => Number.isInteger(value) && value >= 0 && value <= MAX_NUMBER_VALUE;

/** Défauts d'un tarif ; liste vide : il peut être enregistré (brouillon) ou publié. */
export function tariffProblems(
  tariff: TariffDraft,
  context: TariffContext,
  stage: TariffStage,
): TariffProblem[] {
  const problems =
    tariff.packDiscountBps === null
      ? bracketTariffProblems(tariff, context, stage)
      : packProblems(tariff, context);
  problems.push(...frequencyProblems(tariff));
  if (!isAmount(tariff.minimum)) problems.push(invalid('minimum', 'out_of_range'));
  return problems;
}

/**
 * Pack à remise : prix = max(minimum, Σ prix des types − remise). Interprétation prudente : une base,
 * des tranches, des suppléments ou une remise récurrente n'auraient aucun effet sur ce prix (la
 * fréquence agit déjà sur chaque type) ; ils sont refusés plutôt qu'ignorés.
 */
function packProblems(tariff: TariffDraft, context: TariffContext): TariffProblem[] {
  const problems: TariffProblem[] = [];
  if (!context.isPack) return [invalid('packDiscountBps', 'not_applicable')];
  const discount = tariff.packDiscountBps as number;
  if (!Number.isInteger(discount) || discount < 0 || discount > MAX_PACK_DISCOUNT_BPS) {
    problems.push(invalid('packDiscountBps', 'out_of_range'));
  }
  if (tariff.baseParameterCode !== null) problems.push(invalid('baseParameterCode', 'not_applicable'));
  if (tariff.brackets.length) problems.push(invalid('brackets', 'not_applicable'));
  if (tariff.supplements.length) problems.push(invalid('supplements', 'not_applicable'));
  if (tariff.frequencyCoefficients.length) problems.push(invalid('frequencyCoefficients', 'not_applicable'));
  return problems;
}

function bracketTariffProblems(
  tariff: TariffDraft,
  context: TariffContext,
  stage: TariffStage,
): TariffProblem[] {
  if (tariff.baseParameterCode === null) return [invalid('baseParameterCode', 'required')];
  const problems: TariffProblem[] = [];
  const base = context.askedParameters.find((parameter) => parameter.code === tariff.baseParameterCode);
  if (!base) problems.push(incomplete('base_not_asked', null));
  else if (base.kind !== 'number') problems.push(incomplete('base_not_number', null));
  else if (!base.active) problems.push(incomplete('base_inactive', null));

  problems.push(...bracketProblems(tariff, base?.kind === 'number' ? (base.min ?? 0) : null, stage));
  tariff.supplements.forEach((supplement, index) => {
    problems.push(...supplementProblems(supplement, index, context.askedParameters));
  });
  return problems;
}

/** Tranches entières, contiguës, sans chevauchement ni trou, depuis la borne basse de la base. */
function bracketProblems(tariff: TariffDraft, baseMin: number | null, stage: TariffStage): TariffProblem[] {
  const problems: TariffProblem[] = [];
  const { brackets } = tariff;
  if (!brackets.length) return stage === 'publish' ? [publishWithoutBracket()] : [];
  brackets.forEach((bracket, index) => {
    if (!isNumberValue(bracket.from)) problems.push(invalid(`brackets[${index}].from`, 'out_of_range'));
    if (!isNumberValue(bracket.to) || bracket.to < bracket.from) {
      problems.push(invalid(`brackets[${index}].to`, 'out_of_range'));
    }
    if (!isAmount(bracket.amount)) problems.push(invalid(`brackets[${index}].amount`, 'out_of_range'));
  });
  if (baseMin !== null && (brackets[0] as TariffDraft['brackets'][number]).from > baseMin) {
    problems.push(incomplete('first_bracket_above_min', 0));
  }
  for (let index = 1; index < brackets.length; index += 1) {
    const previous = brackets[index - 1] as TariffDraft['brackets'][number];
    const current = brackets[index] as TariffDraft['brackets'][number];
    if (current.from <= previous.to) problems.push(incomplete('brackets_overlap', index));
    else if (current.from > previous.to + 1) problems.push(incomplete('brackets_gap', index));
  }
  return problems;
}

/**
 * Tarif par tranches publié sans aucune tranche : toute la plage de la base reste découverte, ce
 * qui est traité comme un trou au rang 0 (interprétation, R-CA-08).
 */
function publishWithoutBracket(): TariffProblem {
  return incomplete('brackets_gap', 0);
}

function supplementProblems(
  supplement: TariffSupplement,
  index: number,
  asked: readonly ParameterDefinition[],
): TariffProblem[] {
  const problems: TariffProblem[] = [];
  const at = `supplements[${index}]`;
  const parameter = asked.find((candidate) => candidate.code === supplement.parameterCode);
  if (!parameter) {
    problems.push(incomplete('supplement_parameter_not_asked', index));
  } else {
    if (!choiceIsKnown(parameter, supplement.choiceCode)) problems.push(incomplete('unknown_choice', index));
    if (supplement.mode === 'per_unit' && parameter.kind !== 'number') {
      problems.push(incomplete('mode_incompatible', index));
    }
  }
  if (supplement.mode === 'coefficient') {
    if (supplement.amount !== null) problems.push(invalid(`${at}.amount`, 'not_applicable'));
    if (supplement.coefficientBps === null) problems.push(invalid(`${at}.coefficientBps`, 'required'));
    else if (!isCoefficientBps(supplement.coefficientBps))
      problems.push(invalid(`${at}.coefficientBps`, 'out_of_range'));
  } else {
    if (supplement.coefficientBps !== null) problems.push(invalid(`${at}.coefficientBps`, 'not_applicable'));
    if (supplement.amount === null) problems.push(invalid(`${at}.amount`, 'required'));
    else if (!isAmount(supplement.amount)) problems.push(invalid(`${at}.amount`, 'out_of_range'));
  }
  if (!isNumberValue(supplement.includedUnits)) problems.push(invalid(`${at}.includedUnits`, 'out_of_range'));
  else if (supplement.mode !== 'per_unit' && supplement.includedUnits !== 0) {
    problems.push(invalid(`${at}.includedUnits`, 'not_applicable'));
  }
  return problems;
}

/**
 * Valeur de choix d'un supplément (R-CA-11, `unknown_choice`). Interprétation prudente : un
 * paramètre « choix » exige une valeur connue (active ou non, R-CA-06) ; un autre paramètre n'en
 * porte aucune.
 */
function choiceIsKnown(parameter: ParameterDefinition, choiceCode: string | null): boolean {
  if (parameter.kind !== 'choice') return choiceCode === null;
  return parameter.choices.some((choice) => choice.code === choiceCode);
}

function frequencyProblems(tariff: TariffDraft): TariffProblem[] {
  const problems: TariffProblem[] = [];
  const keys = new Set<string>();
  tariff.frequencyCoefficients.forEach((entry, index) => {
    const at = `frequencyCoefficients[${index}]`;
    if (!FREQUENCY_KEY.test(entry.key)) problems.push(invalid(`${at}.key`, 'invalid_type'));
    else if (keys.has(entry.key)) problems.push(invalid(`${at}.key`, 'duplicate'));
    keys.add(entry.key);
    if (!isCoefficientBps(entry.coefficientBps))
      problems.push(invalid(`${at}.coefficientBps`, 'out_of_range'));
  });
  return problems;
}
