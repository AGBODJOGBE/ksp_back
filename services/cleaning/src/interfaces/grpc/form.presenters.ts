import { type cleaningV1 } from '@ksp/contracts';
import {
  type FieldInput,
  type ServiceDefinitionInput,
} from '../../application/catalog/admin-catalog.use-cases';
import { type PricingInput } from '../../application/catalog/pricing-input';
import { type Answers, type OptionSelection } from '../../domain/answers';
import { type FormField, type ServiceDefinition } from '../../domain/catalog';
import { CURRENCY } from '../../domain/money';
import { type PriceCalculation } from '../../domain/simulator';

/**
 * Formulaire paramétrable (ADR-033) : réponses, définitions et détail du calcul, entre le modèle
 * et les messages du contrat. Conventions du contrat : chaîne vide = absente, coefficient 0 =
 * aucun, Money absent = prix non fixé.
 */
const money = (amount: number) => ({ amount, currency: CURRENCY });
const optionalMoney = (amount: number | null) => (amount === null ? undefined : money(amount));
const amountOf = (value: { amount: number } | undefined) => (value ? value.amount : null);
const text = (value: string | null | undefined) => value ?? '';
const orNull = (value: string) => (value ? value : null);

// ---------------------------------------------------------------------------
// Réponses
// ---------------------------------------------------------------------------

/** Réponses reçues ; une valeur vide (aucun type renseigné) devient null et sera refusée. */
export function answersFromProto(set: cleaningV1.AnswerSet | undefined): Answers {
  const answers: Record<string, unknown> = {};
  for (const [code, value] of Object.entries(set?.values ?? {})) {
    answers[code] = value.numberValue ?? value.choiceValue ?? value.booleanValue ?? null;
  }
  return answers as Answers;
}

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

export const selectionsFromProto = (selections: cleaningV1.OptionSelection[]): OptionSelection[] =>
  selections.map((selection) => ({ code: selection.code, answers: answersFromProto(selection.answers) }));

export const selectionsToProto = (selections: OptionSelection[]): cleaningV1.OptionSelection[] =>
  selections.map((selection) => ({ code: selection.code, answers: answersToProto(selection.answers) }));

// ---------------------------------------------------------------------------
// Formulaire public (sans aucun prix) et définition complète (back-office)
// ---------------------------------------------------------------------------

const formField = (field: FormField): cleaningV1.FormField => ({
  code: field.code,
  label: field.label,
  type: field.type,
  required: field.required,
  helpText: text(field.helpText),
  unitLabel: text(field.unitLabel),
  min: field.min ?? 0,
  max: field.max ?? 0,
  choices: field.choices.filter((choice) => choice.active).map(({ code, label }) => ({ code, label })),
});

/** Formulaire public : éléments actifs seulement, jamais de prix, de supplément ni de coefficient. */
export function presentForm(service: ServiceDefinition): cleaningV1.ServiceForm {
  const active = <T extends { active: boolean }>(items: T[]) => items.filter((item) => item.active);
  return {
    fields: active(service.fields).map(formField),
    options: active(service.options).map((option) => ({
      code: option.code,
      label: option.label,
      description: text(option.description),
      fields: active(option.fields).map(formField),
    })),
    frequencies: active(service.pricing.frequencies).map(({ code, label }) => ({ code, label })),
  };
}

export const fieldToProto = (field: FormField): cleaningV1.FieldDefinition => ({
  code: field.code,
  label: field.label,
  type: field.type,
  required: field.required,
  helpText: text(field.helpText),
  active: field.active,
  unitLabel: text(field.unitLabel),
  min: field.min ?? 0,
  max: field.max ?? 0,
  pricePerUnit: optionalMoney(field.pricePerUnit),
  choices: field.choices.map((choice) => ({
    code: choice.code,
    label: choice.label,
    supplement: optionalMoney(choice.supplement),
    coefficientBp: choice.coefficientBp ?? 0,
    active: choice.active,
  })),
  supplementIfYes: optionalMoney(field.supplementIfYes),
  coefficientBpIfYes: field.coefficientBpIfYes ?? 0,
});

export const optionsToProto = (service: ServiceDefinition): cleaningV1.OptionDefinition[] =>
  service.options.map((option) => ({
    code: option.code,
    label: option.label,
    description: text(option.description),
    active: option.active,
    flatPrice: optionalMoney(option.flatPrice),
    fields: option.fields.map(fieldToProto),
  }));

const fieldFromProto = (field: cleaningV1.FieldDefinition): FieldInput => ({
  code: field.code,
  label: field.label,
  type: field.type,
  required: field.required,
  helpText: orNull(field.helpText),
  active: field.active,
  unitLabel: orNull(field.unitLabel),
  min: field.min,
  max: field.max,
  pricePerUnit: amountOf(field.pricePerUnit),
  choices: field.choices.map((choice) => ({
    code: choice.code,
    label: choice.label,
    supplement: amountOf(choice.supplement),
    coefficientBp: choice.coefficientBp || null,
    active: choice.active,
  })),
  supplementIfYes: amountOf(field.supplementIfYes),
  coefficientBpIfYes: field.coefficientBpIfYes || null,
});

/** Définition reçue (SaveService, PreviewService), au nouveau format ; les anciens champs sont ignorés. */
export function definitionFromProto(
  service: cleaningV1.ServiceDefinition | undefined,
): ServiceDefinitionInput {
  const pricing = service?.pricing;
  return {
    name: service?.name ?? '',
    description: service?.description ?? '',
    active: service?.active ?? false,
    fields: (service?.fields ?? []).map(fieldFromProto),
    options: (service?.options ?? []).map((option) => ({
      code: option.code,
      label: option.label,
      description: orNull(option.description),
      active: option.active,
      flatPrice: amountOf(option.flatPrice),
      fields: option.fields.map(fieldFromProto),
    })),
    pricing: {
      minimumPrice: amountOf(pricing?.minimumPrice),
      communeCoefficients: pricing?.communeCoefficients ?? [],
      defaultCoefficientBp: pricing?.defaultCoefficientBp ?? 0,
      frequencies: pricing?.frequencies ?? [],
      teamSize: pricing?.teamSize
        ? { ...pricing.teamSize, fieldCode: orNull(pricing.teamSize.fieldCode) }
        : null,
      checklist: (pricing?.checklist ?? []).map(({ code, label }) => ({ code, label })),
    },
  };
}

// ---------------------------------------------------------------------------
// Détail du calcul
// ---------------------------------------------------------------------------

export function calculationToProto(calculation: PriceCalculation): cleaningV1.PriceCalculation {
  return {
    pricingVersion: calculation.pricingVersion ?? 0,
    priced: calculation.priced,
    reason: text(calculation.reason),
    missingPrices: calculation.missingPrices.map((missing) => ({
      optionCode: text(missing.optionCode),
      fieldCode: text(missing.fieldCode),
      choiceCode: text(missing.choiceCode),
    })),
    lines: calculation.lines.map((line) => ({
      kind: line.kind,
      optionCode: text(line.optionCode),
      fieldCode: text(line.fieldCode),
      choiceCode: text(line.choiceCode),
      label: line.label,
      quantity: line.quantity,
      unitLabel: text(line.unitLabel),
      unitPrice: money(line.unitPrice),
      amount: money(line.amount),
    })),
    baseAmount: optionalMoney(calculation.baseAmount),
    coefficients: calculation.coefficients.map((coefficient) => ({
      source: coefficient.source,
      optionCode: text(coefficient.optionCode),
      fieldCode: text(coefficient.fieldCode),
      code: text(coefficient.code),
      label: coefficient.label,
      coefficientBp: coefficient.coefficientBp,
    })),
    subtotal: optionalMoney(calculation.subtotal),
    minimumPrice: optionalMoney(calculation.minimumPrice),
    minimumApplied: calculation.minimumApplied,
    computedPrice: optionalMoney(calculation.computedPrice),
    estimate: calculation.estimate
      ? { low: money(calculation.estimate.low), high: money(calculation.estimate.high) }
      : undefined,
    recommendedTeamSize: calculation.recommendedTeamSize,
  };
}

/** Réponses d'une simulation ou d'une demande : nouveau format si `answers` est présent. */
export function pricingInputFromProto(request: {
  answers?: cleaningV1.AnswerSet | undefined;
  optionSelections: cleaningV1.OptionSelection[];
  premisesType: string;
  quantity: number;
  options: string[];
  frequency: string;
}): PricingInput {
  if (request.answers) {
    return {
      answers: answersFromProto(request.answers),
      optionSelections: selectionsFromProto(request.optionSelections),
      frequency: request.frequency,
    };
  }
  return {
    premisesType: request.premisesType,
    quantity: request.quantity,
    options: request.options,
    frequency: request.frequency,
  };
}
