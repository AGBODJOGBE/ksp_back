import { type cleaningV1, type moneyV1 } from '@ksp/contracts';
import {
  type Answers,
  type FieldInput,
  type FormAnswersInput,
  type OptionSelectionInput,
  type ServiceInput,
} from '../../application/cleaning/cleaning.ports';

/**
 * Formulaire paramétrable du Nettoyage (ADR-033) : réponses, définitions et détail du calcul,
 * entre le JSON du contrat OpenAPI et les messages ksp.cleaning.v1 (chaîne vide ↔ null,
 * coefficient 0 ↔ null, Money absent ↔ null).
 */
const orNull = (value: string | undefined): string | null => (value ? value : null);
const money = (value: moneyV1.Money | undefined) =>
  value ? { amount: value.amount, currency: value.currency } : null;
const requiredMoney = (value: moneyV1.Money | undefined) => money(value) ?? { amount: 0, currency: 'XOF' };
const xof = (amount: number | null | undefined): moneyV1.Money | undefined =>
  amount === null || amount === undefined ? undefined : { amount, currency: 'XOF' };

// ---------------------------------------------------------------------------
// Réponses
// ---------------------------------------------------------------------------

export function answersToProto(answers: Answers): cleaningV1.AnswerSet {
  const values: Record<string, cleaningV1.AnswerValue> = {};
  for (const [code, value] of Object.entries(answers)) {
    values[code] =
      typeof value === 'number'
        ? { numberValue: value }
        : typeof value === 'boolean'
          ? { booleanValue: value }
          : { choiceValue: value };
  }
  return { values };
}

export function answersFromProto(set: cleaningV1.AnswerSet | undefined): Answers {
  const answers: Answers = {};
  for (const [code, value] of Object.entries(set?.values ?? {})) {
    const answer = value.numberValue ?? value.choiceValue ?? value.booleanValue;
    if (answer !== undefined && answer !== null) answers[code] = answer;
  }
  return answers;
}

export const selectionsToProto = (options: OptionSelectionInput[]): cleaningV1.OptionSelection[] =>
  options.map((option) => ({ code: option.code, answers: answersToProto(option.answers ?? {}) }));

export const selectionsFromProto = (options: cleaningV1.OptionSelection[]) =>
  options.map((option) => ({ code: option.code, answers: answersFromProto(option.answers) }));

/**
 * Réponses d'une simulation ou d'une demande : nouveau format si `answers` est présent (même
 * vide), sinon ancien format déprécié (type de local, quantité, codes d'options).
 */
export function formToProto(input: FormAnswersInput) {
  const frequency = input.frequency ?? '';
  if (input.answers !== undefined) {
    const selections = (input.options ?? []).filter(
      (option): option is OptionSelectionInput => typeof option !== 'string',
    );
    return {
      answers: answersToProto(input.answers),
      optionSelections: selectionsToProto(selections),
      premisesType: '',
      quantity: 0,
      options: [],
      frequency,
    };
  }
  return {
    optionSelections: [],
    premisesType: input.premisesType ?? '',
    quantity: input.quantity ?? 0,
    options: (input.options ?? []).filter((option): option is string => typeof option === 'string'),
    frequency,
  };
}

// ---------------------------------------------------------------------------
// Formulaire public (sans prix) et définition complète (back-office)
// ---------------------------------------------------------------------------

const formField = (value: cleaningV1.FormField) => {
  const isNumber = value.type === 'number';
  return {
    code: value.code,
    label: value.label,
    type: value.type,
    required: value.required,
    helpText: orNull(value.helpText),
    unitLabel: isNumber ? orNull(value.unitLabel) : null,
    min: isNumber ? value.min : null,
    max: isNumber ? value.max : null,
    choices: value.choices.map((choice) => ({ code: choice.code, label: choice.label })),
  };
};

export function presentForm(value: cleaningV1.ServiceForm | undefined) {
  return {
    fields: (value?.fields ?? []).map(formField),
    options: (value?.options ?? []).map((option) => ({
      code: option.code,
      label: option.label,
      description: orNull(option.description),
      fields: option.fields.map(formField),
    })),
    frequencies: (value?.frequencies ?? []).map(({ code, label }) => ({ code, label })),
  };
}

const definitionField = (value: cleaningV1.FieldDefinition) => {
  const isNumber = value.type === 'number';
  const isBoolean = value.type === 'boolean';
  return {
    code: value.code,
    label: value.label,
    type: value.type,
    required: value.required,
    helpText: orNull(value.helpText),
    active: value.active,
    unitLabel: isNumber ? orNull(value.unitLabel) : null,
    min: isNumber ? value.min : null,
    max: isNumber ? value.max : null,
    pricePerUnit: money(value.pricePerUnit),
    choices: value.choices.map((choice) => ({
      code: choice.code,
      label: choice.label,
      supplement: money(choice.supplement),
      coefficientBp: choice.coefficientBp || null,
      active: choice.active,
    })),
    supplementIfYes: isBoolean ? money(value.supplementIfYes) : null,
    coefficientBpIfYes: isBoolean ? value.coefficientBpIfYes || null : null,
  };
};

export const presentFields = (fields: cleaningV1.FieldDefinition[]) => fields.map(definitionField);

export const presentOptionDefinitions = (options: cleaningV1.OptionDefinition[]) =>
  options.map((option) => ({
    code: option.code,
    label: option.label,
    description: orNull(option.description),
    active: option.active,
    flatPrice: money(option.flatPrice),
    fields: option.fields.map(definitionField),
  }));

const fieldToProto = (field: FieldInput): cleaningV1.FieldDefinition => ({
  code: field.code,
  label: field.label,
  type: field.type,
  required: field.required,
  helpText: field.helpText ?? '',
  active: field.active,
  unitLabel: field.unitLabel ?? '',
  min: field.min ?? 0,
  max: field.max ?? 0,
  pricePerUnit: xof(field.pricePerUnit),
  choices: (field.choices ?? []).map((choice) => ({
    code: choice.code,
    label: choice.label,
    supplement: xof(choice.supplement),
    coefficientBp: choice.coefficientBp ?? 0,
    active: choice.active,
  })),
  supplementIfYes: xof(field.supplementIfYes),
  coefficientBpIfYes: field.coefficientBpIfYes ?? 0,
});

/** Définition saisie au back-office (nouveau format) → message ServiceDefinition. */
export function definitionToProto(code: string, input: ServiceInput): cleaningV1.ServiceDefinition {
  const p = input.pricing;
  return {
    code,
    name: input.name,
    description: input.description ?? '',
    // Déduite par cleaning (ADR-033).
    unit: '',
    active: input.active,
    fields: input.fields.map(fieldToProto),
    options: (input.options ?? []).map((option) => ({
      code: option.code,
      label: option.label,
      description: option.description ?? '',
      active: option.active,
      flatPrice: xof(option.flatPrice),
      fields: (option.fields ?? []).map(fieldToProto),
    })),
    pricing: {
      version: 0,
      minimumPrice: xof(p.minimumPrice),
      options: [],
      communeCoefficients: p.communeCoefficients ?? [],
      defaultCoefficientBp: p.defaultCoefficientBp ?? 0,
      frequencies: p.frequencies ?? [],
      ...(p.teamSize ? { teamSize: { ...p.teamSize, fieldCode: p.teamSize.fieldCode ?? '' } } : {}),
      checklist: (p.checklist ?? []).map((item) => ({ ...item, done: false })),
      updatedBy: '',
      updatedAt: '',
      updatedByName: '',
    },
  };
}

// ---------------------------------------------------------------------------
// Détail du calcul
// ---------------------------------------------------------------------------

export function presentCalculation(value: cleaningV1.PriceCalculation | undefined) {
  if (!value) return null;
  return {
    pricingVersion: value.pricingVersion || null,
    priced: value.priced,
    reason: orNull(value.reason),
    missingPrices: value.missingPrices.map((missing) => ({
      optionCode: orNull(missing.optionCode),
      fieldCode: orNull(missing.fieldCode),
      choiceCode: orNull(missing.choiceCode),
    })),
    lines: value.lines.map((line) => ({
      kind: line.kind,
      optionCode: orNull(line.optionCode),
      fieldCode: orNull(line.fieldCode),
      choiceCode: orNull(line.choiceCode),
      label: line.label,
      quantity: line.quantity,
      unitLabel: orNull(line.unitLabel),
      unitPrice: requiredMoney(line.unitPrice),
      amount: requiredMoney(line.amount),
    })),
    baseAmount: money(value.baseAmount),
    coefficients: value.coefficients.map((coefficient) => ({
      source: coefficient.source,
      optionCode: orNull(coefficient.optionCode),
      fieldCode: orNull(coefficient.fieldCode),
      code: orNull(coefficient.code),
      label: coefficient.label,
      coefficientBp: coefficient.coefficientBp,
    })),
    subtotal: money(value.subtotal),
    minimumPrice: money(value.minimumPrice),
    minimumApplied: value.minimumApplied,
    computedPrice: money(value.computedPrice),
    estimate: value.estimate
      ? { low: requiredMoney(value.estimate.low), high: requiredMoney(value.estimate.high) }
      : null,
    recommendedTeamSize: value.recommendedTeamSize,
  };
}
