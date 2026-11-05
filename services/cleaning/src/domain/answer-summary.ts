import { type Answers, type AnswerValue, type OptionSelection, type PremisesType } from './answers';
import {
  type FieldType,
  type FormField,
  type LegacyUnit,
  type PricingRule,
  type ServiceDefinition,
} from './catalog';

/**
 * Réponses lisibles d'une demande (ADR-037) : chaque réponse avec le libellé du champ, la valeur
 * affichable (libellé du choix, « Oui » / « Non », nombre et unité), résolue avec la version de
 * grille utilisée pour le calcul. Sert au back-office et à l'espace client, sans aucun prix.
 */
export interface SummaryField {
  code: string;
  label: string;
  type: FieldType;
  value: AnswerValue;
  /** Valeur affichable : « 120 m² », « Très sale », « Oui ». */
  display: string;
  unitLabel: string | null;
}

export interface SummaryOption {
  optionCode: string;
  label: string;
  fields: SummaryField[];
}

export interface AnswerSummary {
  /** Réponses aux champs de la prestation, dans l'ordre du formulaire. */
  fields: SummaryField[];
  /** Options choisies, dans l'ordre du formulaire, avec leurs réponses. */
  options: SummaryOption[];
  /** Fréquence choisie avec son libellé, null si aucune. */
  frequency: { code: string; label: string } | null;
}

/** Ce qu'il faut d'une définition (version de grille) pour résumer des réponses. */
export type SummaryDefinition = Pick<ServiceDefinition, 'fields' | 'options'> & {
  pricing: Pick<PricingRule, 'frequencies'>;
};

/** Définition vide : prestation inconnue, les codes servent de libellés. */
export const UNKNOWN_DEFINITION: SummaryDefinition = {
  fields: [],
  options: [],
  pricing: { frequencies: [] },
};

/** Réponses à résumer : celles du client ou les mesures constatées. */
export interface SummarySource {
  answers: Answers;
  optionSelections: OptionSelection[];
  frequency: string | null;
}

const NBSP = ' ';
const formatCount = (value: number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);

function display(field: FormField | undefined, value: AnswerValue): string {
  if (typeof value === 'boolean') return value ? 'Oui' : 'Non';
  if (typeof value === 'number') {
    const unit = field?.unitLabel;
    return unit ? `${formatCount(value)} ${unit}` : formatCount(value);
  }
  return field?.choices.find((choice) => choice.code === value)?.label ?? value;
}

const typeOf = (value: AnswerValue): FieldType =>
  typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'choice';

/**
 * Réponses d'une liste de champs, dans l'ordre de la définition ; une réponse à un champ inconnu de
 * cette version (cas anormal) suit, avec son code pour libellé. Un oui/non sans réponse n'apparaît pas.
 */
function summarizeFields(fields: FormField[], answers: Answers): SummaryField[] {
  const known = fields.flatMap((field) => {
    const value = answers[field.code];
    if (value === undefined) return [];
    return [
      {
        code: field.code,
        label: field.label,
        type: field.type,
        value,
        display: display(field, value),
        unitLabel: field.type === 'number' ? field.unitLabel : null,
      },
    ];
  });
  const unknown = Object.entries(answers)
    .filter(([code]) => !fields.some((field) => field.code === code))
    .map(([code, value]) => ({
      code,
      label: code,
      type: typeOf(value),
      value,
      display: display(undefined, value),
      unitLabel: null,
    }));
  return [...known, ...unknown];
}

/** Résumé lisible des réponses, avec la définition de la version de grille utilisée. */
export function summarizeAnswers(service: SummaryDefinition, source: SummarySource): AnswerSummary {
  const position = (code: string) => {
    const index = service.options.findIndex((option) => option.code === code);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  const options = [...source.optionSelections]
    .sort((a, b) => position(a.code) - position(b.code))
    .map((selection) => {
      const option = service.options.find((candidate) => candidate.code === selection.code);
      return {
        optionCode: selection.code,
        label: option?.label ?? selection.code,
        fields: summarizeFields(option?.fields ?? [], selection.answers),
      };
    });
  const frequency = source.frequency
    ? {
        code: source.frequency,
        label:
          service.pricing.frequencies.find((candidate) => candidate.code === source.frequency)?.label ??
          source.frequency,
      }
    : null;
  return { fields: summarizeFields(service.fields, source.answers), options, frequency };
}

// ---------------------------------------------------------------------------
// Demande antérieure à l'ADR-033 : type de locaux et quantité.
// ---------------------------------------------------------------------------

const PREMISES_LABELS: Record<PremisesType, string> = {
  apartment: 'Appartement',
  house: 'Maison',
  office: 'Bureau',
  shop: 'Commerce',
  warehouse: 'Entrepôt',
  other: 'Autre',
};

const LEGACY_UNIT_LABELS: Record<LegacyUnit, string> = {
  square_meter: 'm²',
  room: 'pièces',
  septic_tank: 'fosses',
  cubic_meter: 'm³',
};

/** Anciennes fréquences (déprécié), si la prestation n'en a pas de même code. */
const LEGACY_FREQUENCY_LABELS: Record<string, string> = {
  once: 'Une fois',
  weekly: 'Chaque semaine',
  monthly: 'Chaque mois',
};

export interface LegacyAnswers {
  premisesType: PremisesType;
  quantity: number;
  /** Codes des options choisies. */
  options: string[];
  frequency: string | null;
}

/**
 * Demande à l'ancien format (sans réponses enregistrées) : type de locaux et quantité, avec leurs
 * libellés ; l'unité est celle de la prestation (ancienne unité) ; les options gardent leur libellé
 * s'il est connu. Sans définition (prestation supprimée) : unité inconnue, libellés = codes.
 */
export function summarizeLegacy(service: ServiceDefinition | null, legacy: LegacyAnswers): AnswerSummary {
  const unitLabel = service ? LEGACY_UNIT_LABELS[service.unit] : null;
  const premisesLabel = PREMISES_LABELS[legacy.premisesType] ?? legacy.premisesType;
  return {
    fields: [
      {
        code: 'premises_type',
        label: 'Type de locaux',
        type: 'choice',
        value: legacy.premisesType,
        display: premisesLabel,
        unitLabel: null,
      },
      {
        code: 'quantity',
        label: 'Quantité',
        type: 'number',
        value: legacy.quantity,
        display: unitLabel ? `${formatCount(legacy.quantity)} ${unitLabel}` : formatCount(legacy.quantity),
        unitLabel,
      },
    ],
    options: legacy.options.map((code) => ({
      optionCode: code,
      label: service?.options.find((option) => option.code === code)?.label ?? code,
      fields: [],
    })),
    frequency: legacy.frequency
      ? {
          code: legacy.frequency,
          label:
            service?.pricing.frequencies.find((candidate) => candidate.code === legacy.frequency)?.label ??
            LEGACY_FREQUENCY_LABELS[legacy.frequency] ??
            legacy.frequency,
        }
      : null,
  };
}
