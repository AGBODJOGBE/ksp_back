import { MAX_NUMBER_VALUE } from './tariff-validation';
import { type ParameterDefinition, type ParameterValues } from './types';

/**
 * Contrôle des types choisis et des valeurs envoyées au simulateur et à la demande (R-PX-03,
 * R-PX-09, R-CA-06). Raisons de `CLEANING_VALIDATION_FAILED` ; champ `cleaningTypeIds[i]` ou
 * `values.<code>`.
 */
export type ValueProblemReason =
  | 'duplicate'
  | 'pack_item_also_selected'
  | 'unknown_parameter'
  | 'invalid_type'
  | 'out_of_range'
  | 'unknown_choice'
  | 'required';

export interface ValueProblem {
  field: string;
  reason: ValueProblemReason;
}

/** Type choisi, avec les paramètres propres à son offre (R-CA-02). */
export interface SelectedType {
  cleaningTypeId: string;
  /** Types contenus si c'est un pack ; vide sinon. */
  packItemIds: readonly string[];
  extraParameters: readonly ParameterDefinition[];
}

export interface SelectionInput {
  selected: readonly SelectedType[];
  placeParameters: readonly ParameterDefinition[];
  values: Readonly<Record<string, unknown>>;
  /** Simulateur de test du back-office : éléments inactifs acceptés (R-CA-08). */
  acceptInactive?: boolean;
}

export function selectionProblems(input: SelectionInput): ValueProblem[] {
  const acceptInactive = input.acceptInactive ?? false;
  const problems = typeProblems(input.selected);
  const asked = askedParameters(input.placeParameters, input.selected).filter(
    (parameter) => acceptInactive || parameter.active,
  );
  const byCode = new Map(asked.map((parameter) => [parameter.code, parameter]));
  for (const [code, value] of Object.entries(input.values)) {
    const parameter = byCode.get(code);
    if (!parameter) {
      problems.push({ field: `values.${code}`, reason: 'unknown_parameter' });
      continue;
    }
    const reason = valueProblem(parameter, value, acceptInactive);
    if (reason) problems.push({ field: `values.${code}`, reason });
  }
  for (const parameter of asked) {
    if (parameter.required && input.values[parameter.code] === undefined) {
      problems.push({ field: `values.${parameter.code}`, reason: 'required' });
    }
  }
  return problems;
}

/** Un type ne figure qu'une fois ; un pack n'est pas envoyé avec l'un de ses types. */
function typeProblems(selected: readonly SelectedType[]): ValueProblem[] {
  const problems: ValueProblem[] = [];
  const seen = new Set<string>();
  const inPacks = new Set(selected.flatMap((type) => type.packItemIds));
  selected.forEach((type, index) => {
    const field = `cleaningTypeIds[${index}]`;
    if (seen.has(type.cleaningTypeId)) problems.push({ field, reason: 'duplicate' });
    else if (inPacks.has(type.cleaningTypeId)) problems.push({ field, reason: 'pack_item_also_selected' });
    seen.add(type.cleaningTypeId);
  });
  return problems;
}

/** Paramètres du lieu puis des offres choisies, sans doublon de code, dans l'ordre. */
function askedParameters(
  placeParameters: readonly ParameterDefinition[],
  selected: readonly SelectedType[],
): ParameterDefinition[] {
  const byCode = new Map<string, ParameterDefinition>();
  for (const parameter of [...placeParameters, ...selected.flatMap((type) => type.extraParameters)]) {
    if (!byCode.has(parameter.code)) byCode.set(parameter.code, parameter);
  }
  return [...byCode.values()];
}

function valueProblem(
  parameter: ParameterDefinition,
  value: unknown,
  acceptInactive: boolean,
): ValueProblemReason | null {
  if (parameter.kind === 'number') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return 'invalid_type';
    const min = Math.max(0, parameter.min ?? 0);
    const max = Math.min(MAX_NUMBER_VALUE, parameter.max ?? MAX_NUMBER_VALUE);
    return value < min || value > max ? 'out_of_range' : null;
  }
  if (parameter.kind === 'boolean') return typeof value === 'boolean' ? null : 'invalid_type';
  if (typeof value !== 'string') return 'invalid_type';
  const choice = parameter.choices.find((candidate) => candidate.code === value);
  return choice && (choice.active || acceptInactive) ? null : 'unknown_choice';
}

/** Un oui/non facultatif absent vaut « non » (R-PX-09). */
export function withAbsentBooleansAsNo(
  parameters: readonly ParameterDefinition[],
  values: ParameterValues,
): ParameterValues {
  const completed: Record<string, ParameterValues[string]> = { ...values };
  for (const parameter of parameters) {
    if (parameter.kind === 'boolean' && completed[parameter.code] === undefined)
      completed[parameter.code] = false;
  }
  return completed;
}
