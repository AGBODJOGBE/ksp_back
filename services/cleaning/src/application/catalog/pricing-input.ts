import {
  type Answers,
  checkAnswers,
  convertLegacy,
  type FormAnswers,
  isAnswerValue,
  type OptionSelection,
  PREMISES_TYPE_FIELD,
  PREMISES_TYPES,
} from '../../domain/answers';
import { isCode, type ServiceDefinition, teamSizeField } from '../../domain/catalog';
import { CleaningErrors } from '../shared/errors';
import { oneOf, requirePositiveInt } from '../shared/validation';

/**
 * Réponses d'une simulation, d'une demande de devis ou d'un essai de grille (ADR-033). Deux
 * formats, distingués par la présence de `answers` (même vide) :
 * - nouveau : `answers`, `optionSelections`, `frequency` (code) — validation stricte ;
 * - ancien (déprécié) : `premisesType`, `quantity`, `options` (codes), `frequency` parmi once,
 *   weekly, monthly — converti, une réponse obligatoire manquante rend le calcul incomplet.
 */
export interface PricingInput {
  answers?: Answers;
  optionSelections?: OptionSelection[];
  premisesType?: string;
  quantity?: number;
  options?: string[];
  /** Code de fréquence ; vide : aucune. */
  frequency?: string;
}

export const LEGACY_FREQUENCIES = ['once', 'weekly', 'monthly'] as const;

export interface ResolvedAnswers {
  value: FormAnswers;
  /** Ancien format sans toutes les réponses obligatoires du nouveau formulaire. */
  incomplete: boolean;
}

function parseAnswers(field: string, answers: unknown): Answers {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw CleaningErrors.invalid(field);
  for (const [code, value] of Object.entries(answers)) {
    if (!isCode(code)) throw CleaningErrors.answerRefused(`${field}.${code}`, 'unknown_field');
    if (!isAnswerValue(value)) throw CleaningErrors.answerRefused(`${field}.${code}`, 'invalid_type');
  }
  return answers as Answers;
}

/** Nouveau format : contrôle strict contre la définition. */
export function resolveNewFormat(service: ServiceDefinition, input: PricingInput): ResolvedAnswers {
  const value: FormAnswers = {
    answers: parseAnswers('answers', input.answers),
    options: (input.optionSelections ?? []).map((selection, index) => ({
      code: selection.code,
      answers: parseAnswers(`options[${index}].answers`, selection.answers ?? {}),
    })),
    frequency: input.frequency || null,
  };
  const check = checkAnswers(service, value);
  if (!check.ok) throw CleaningErrors.answerRefused(check.problem.field, check.problem.reason);
  return { value: check.value, incomplete: false };
}

/** Ancien format (déprécié) : converti vers le nouveau ; une erreur désigne l'ancien champ. */
function resolveLegacy(service: ServiceDefinition, input: PricingInput): ResolvedAnswers {
  const premisesType = oneOf('premisesType', input.premisesType ?? '', PREMISES_TYPES);
  const quantity = requirePositiveInt('quantity', input.quantity ?? 0);
  const frequency = input.frequency ? oneOf('frequency', input.frequency, LEGACY_FREQUENCIES) : null;
  const options = input.options ?? [];
  if (!options.every(isCode)) throw CleaningErrors.invalid('options');
  const converted = convertLegacy(service, { premisesType, quantity, options, frequency });
  if (!converted) throw CleaningErrors.invalid('quantity');
  const check = checkAnswers(service, converted, true);
  if (!check.ok) {
    const quantityField = teamSizeField(service)?.code;
    const { field, reason } = check.problem;
    if (field === `answers.${quantityField}`) throw CleaningErrors.answerRefused('quantity', reason);
    if (field === `answers.${PREMISES_TYPE_FIELD}`)
      throw CleaningErrors.answerRefused('premisesType', reason);
    throw CleaningErrors.answerRefused('options', reason);
  }
  return { value: check.value, incomplete: check.incomplete };
}

export function resolveAnswers(service: ServiceDefinition, input: PricingInput): ResolvedAnswers {
  return input.answers !== undefined ? resolveNewFormat(service, input) : resolveLegacy(service, input);
}
