import { type FormField, isCode, type ServiceDefinition, teamSizeField } from './catalog';

/**
 * Réponses du client au formulaire d'une prestation (ADR-033) et conversion de l'ancien format
 * (type de local, quantité, codes d'options), toléré jusqu'à la migration du portail.
 */
export type AnswerValue = number | string | boolean;
export type Answers = Record<string, AnswerValue>;

export interface OptionSelection {
  code: string;
  answers: Answers;
}

export interface FormAnswers {
  answers: Answers;
  options: OptionSelection[];
  /** Code de fréquence, null si aucune. */
  frequency: string | null;
}

export type AnswerProblemReason =
  | 'unknown_field'
  | 'required'
  | 'invalid_type'
  | 'out_of_range'
  | 'unknown_choice'
  | 'unknown_option'
  | 'duplicate_option'
  | 'unknown_frequency';

export interface AnswerProblem {
  field: string;
  reason: AnswerProblemReason;
}

export type AnswerCheck =
  { ok: true; value: FormAnswers; incomplete: boolean } | { ok: false; problem: AnswerProblem };

const activeFields = (fields: FormField[]) => fields.filter((field) => field.active);

function checkFields(
  fields: FormField[],
  answers: Answers,
  path: string,
  lenient: boolean,
): AnswerProblem | 'incomplete' | null {
  const active = activeFields(fields);
  for (const code of Object.keys(answers)) {
    if (!active.some((field) => field.code === code))
      return { field: `${path}.${code}`, reason: 'unknown_field' };
  }
  let incomplete = false;
  for (const field of active) {
    const value = answers[field.code];
    const at = `${path}.${field.code}`;
    if (value === undefined) {
      if (!field.required) continue;
      if (!lenient) return { field: at, reason: 'required' };
      incomplete = true;
      continue;
    }
    if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isInteger(value)) return { field: at, reason: 'invalid_type' };
      if (value < (field.min ?? 0) || value > (field.max ?? 0)) return { field: at, reason: 'out_of_range' };
    } else if (field.type === 'choice') {
      if (typeof value !== 'string') return { field: at, reason: 'invalid_type' };
      if (!field.choices.some((choice) => choice.code === value && choice.active))
        return { field: at, reason: 'unknown_choice' };
    } else if (typeof value !== 'boolean') {
      return { field: at, reason: 'invalid_type' };
    }
  }
  return incomplete ? 'incomplete' : null;
}

/**
 * Validation stricte des réponses contre la définition en vigueur. En mode `lenient` (ancien
 * format converti), une réponse obligatoire absente n'est pas une erreur : le calcul sera
 * `answers_incomplete` ; une fréquence inconnue est sans effet.
 */
export function checkAnswers(service: ServiceDefinition, input: FormAnswers, lenient = false): AnswerCheck {
  let incomplete = false;
  const own = checkFields(service.fields, input.answers, 'answers', lenient);
  if (own && own !== 'incomplete') return { ok: false, problem: own };
  if (own === 'incomplete') incomplete = true;

  const seen = new Set<string>();
  for (const [index, selection] of input.options.entries()) {
    const option = service.options.find((candidate) => candidate.code === selection.code && candidate.active);
    if (!option) return { ok: false, problem: { field: `options[${index}].code`, reason: 'unknown_option' } };
    if (seen.has(option.code))
      return { ok: false, problem: { field: `options[${index}].code`, reason: 'duplicate_option' } };
    seen.add(option.code);
    const result = checkFields(option.fields, selection.answers, `options[${index}].answers`, lenient);
    if (result && result !== 'incomplete') return { ok: false, problem: result };
    if (result === 'incomplete') incomplete = true;
  }

  const frequencies = service.pricing.frequencies.filter((frequency) => frequency.active);
  let frequency = input.frequency;
  if (frequency !== null && !frequencies.some((candidate) => candidate.code === frequency)) {
    if (!lenient) return { ok: false, problem: { field: 'frequency', reason: 'unknown_frequency' } };
    frequency = null;
  }
  if (frequency === null && frequencies.length && !lenient) {
    return { ok: false, problem: { field: 'frequency', reason: 'required' } };
  }
  return { ok: true, value: { ...input, frequency }, incomplete };
}

// ---------------------------------------------------------------------------
// Ancien format (déprécié) : type de local, quantité, codes d'options.
// ---------------------------------------------------------------------------

/** Types de local de l'ancien formulaire. */
export const PREMISES_TYPES = ['apartment', 'house', 'office', 'shop', 'warehouse', 'other'] as const;
export type PremisesType = (typeof PREMISES_TYPES)[number];

/** Champ qui reçoit l'ancien type de local, s'il existe dans la prestation. */
export const PREMISES_TYPE_FIELD = 'premises_type';

/** Ancien type de local → valeur du champ `premises_type` (other : sans réponse). */
const PREMISES_TO_CHOICE: Record<PremisesType, string | null> = {
  apartment: 'housing',
  house: 'housing',
  office: 'office',
  shop: 'shop',
  warehouse: 'warehouse',
  other: null,
};

/** Valeur du champ `premises_type` → ancien type de local, pour les anciens lecteurs. */
const CHOICE_TO_PREMISES: Record<string, PremisesType> = {
  housing: 'house',
  office: 'office',
  shop: 'shop',
  warehouse: 'warehouse',
};

export interface LegacyInput {
  premisesType: PremisesType;
  quantity: number;
  options: string[];
  frequency: string | null;
}

/**
 * Conversion de l'ancien format : la quantité devient la réponse au champ de la taille d'équipe,
 * le type de local celle du champ `premises_type` s'il existe, chaque option `{ code, answers: {} }`.
 * Null si la prestation n'a pas de champ pour la quantité.
 */
export function convertLegacy(service: ServiceDefinition, input: LegacyInput): FormAnswers | null {
  const quantityField = teamSizeField(service);
  if (!quantityField) return null;
  const answers: Answers = { [quantityField.code]: input.quantity };
  const premises = service.fields.find(
    (field) => field.code === PREMISES_TYPE_FIELD && field.type === 'choice' && field.active,
  );
  const premisesChoice = PREMISES_TO_CHOICE[input.premisesType];
  if (premises?.choices.some((choice) => choice.code === premisesChoice && choice.active))
    answers[premises.code] = premisesChoice!;
  return {
    answers,
    options: [...new Set(input.options)].map((code) => ({ code, answers: {} })),
    frequency: input.frequency,
  };
}

/** Ancienne quantité : réponse au champ de la taille d'équipe, 1 sinon. */
export function legacyQuantity(service: ServiceDefinition, answers: Answers): number {
  const field = teamSizeField(service);
  const value = field ? answers[field.code] : undefined;
  return typeof value === 'number' && value >= 1 ? value : 1;
}

/** Ancien type de local : réponse au champ `premises_type`, other sinon. */
export function legacyPremisesType(answers: Answers): PremisesType {
  const value = answers[PREMISES_TYPE_FIELD];
  return (typeof value === 'string' && CHOICE_TO_PREMISES[value]) || 'other';
}

/** Forme d'une réponse reçue (avant validation contre la définition). */
export function isAnswerValue(value: unknown): value is AnswerValue {
  return typeof value === 'number' || typeof value === 'boolean' || isCode(value);
}
