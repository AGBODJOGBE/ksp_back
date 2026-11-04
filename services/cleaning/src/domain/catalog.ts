import { BASIS_POINTS, isWholeAmount } from './money';

/**
 * Catalogue des prestations (UC-CL-11, ADR-033). Une prestation est entièrement définie au
 * back-office : champs du formulaire, options (avec leurs propres champs) et grille (minimum,
 * coefficients par commune, fréquences, taille d'équipe, liste de contrôle). Chaque enregistrement
 * crée une nouvelle version. Tant que l'équipe Nettoyage n'a pas fixé un prix, il vaut null.
 */
export const FIELD_TYPES = ['number', 'choice', 'boolean'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Bornes des réponses de type nombre (entiers). */
export const MAX_NUMBER_ANSWER = 1_000_000;
export const MAX_COEFFICIENT_BP = 10 * BASIS_POINTS;

export interface FieldChoice {
  code: string;
  label: string;
  /** Supplément en FCFA, null si non fixé. */
  supplement: number | null;
  /** Coefficient en points de base, null si aucun. Les deux à null : valeur sans prix. */
  coefficientBp: number | null;
  active: boolean;
}

/** Champ du formulaire. Les propriétés propres à un autre type valent null (ou une liste vide). */
export interface FormField {
  code: string;
  label: string;
  type: FieldType;
  required: boolean;
  helpText: string | null;
  active: boolean;
  /** number : unité libre (« m² », « pièces »…), bornes entières incluses et prix par unité. */
  unitLabel: string | null;
  min: number | null;
  max: number | null;
  pricePerUnit: number | null;
  /** choice : valeurs, dans l'ordre d'affichage. */
  choices: FieldChoice[];
  /** boolean : effet de la réponse « oui » (« non » n'a jamais d'effet). */
  supplementIfYes: number | null;
  coefficientBpIfYes: number | null;
}

/** Option (prestation complémentaire) : forfait facultatif et champs propres. */
export interface ServiceOption {
  code: string;
  label: string;
  description: string | null;
  active: boolean;
  /** Forfait ; null : pas de forfait (une option sans champ et sans forfait n'a pas de prix). */
  flatPrice: number | null;
  fields: FormField[];
}

export interface ServiceFrequency {
  code: string;
  label: string;
  coefficientBp: number;
  active: boolean;
}

/** Une personne pour `unitsPerAgent` unités du champ désigné, entre un minimum et un maximum. */
export interface TeamSizeRule {
  /** Champ number de la prestation qui porte la quantité ; null : taille minimale. */
  fieldCode: string | null;
  unitsPerAgent: number;
  minAgents: number;
  maxAgents: number;
}

export interface ChecklistTemplateItem {
  code: string;
  label: string;
}

/** Version datée de la grille : elle couvre toute la définition (champs, options, grille). */
export interface PricingRule {
  version: number;
  minimumPrice: number | null;
  /** Coefficient par commune (clé normalisée), en points de base. */
  communeCoefficients: Record<string, number>;
  defaultCoefficientBp: number;
  frequencies: ServiceFrequency[];
  teamSize: TeamSizeRule;
  checklist: ChecklistTemplateItem[];
  updatedBy: string;
  updatedAt: Date;
}

/** Unités de l'ancien formulaire public, dépréciées (ADR-033) : déduites du champ de la taille d'équipe. */
export const LEGACY_UNITS = ['square_meter', 'room', 'septic_tank', 'cubic_meter'] as const;
export type LegacyUnit = (typeof LEGACY_UNITS)[number];

export interface ServiceDefinition {
  code: string;
  name: string;
  description: string;
  /** Déprécié : unité de l'ancien formulaire public. */
  unit: LegacyUnit;
  active: boolean;
  fields: FormField[];
  options: ServiceOption[];
  pricing: PricingRule;
}

/** Définition saisie au back-office, avant versionnement. */
export type ServiceDraft = Omit<ServiceDefinition, 'code' | 'unit' | 'pricing'> & {
  pricing: Omit<PricingRule, 'version' | 'updatedBy' | 'updatedAt'>;
};

export const DEFAULT_TEAM_SIZE: TeamSizeRule = {
  fieldCode: null,
  unitsPerAgent: 100,
  minAgents: 1,
  maxAgents: 10,
};

/** Liste de contrôle d'un passage quand la prestation n'en définit pas. */
export const DEFAULT_CHECKLIST: ChecklistTemplateItem[] = [
  { code: 'arrival', label: 'Arrivée sur place et accueil du client' },
  { code: 'cleaning_done', label: 'Prestation réalisée selon le devis' },
  { code: 'site_left_clean', label: 'Matériel rangé, déchets évacués' },
  { code: 'customer_review', label: 'Tour final avec le client' },
];

const CODE = /^[a-z][a-z0-9_]{1,49}$/;

export function isCode(value: unknown): value is string {
  return typeof value === 'string' && CODE.test(value);
}

/** Clé d'une commune : minuscules, sans accents, tirets à la place des espaces. */
export function normalizeCommune(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

export function communeCoefficient(
  rule: Pick<PricingRule, 'communeCoefficients' | 'defaultCoefficientBp'>,
  commune: string,
): number {
  return rule.communeCoefficients[normalizeCommune(commune)] ?? rule.defaultCoefficientBp;
}

/**
 * Taille d'équipe recommandée : fonction de la quantité (réponse au champ désigné), ou de la
 * demande du client quand il la précise, toujours dans les bornes de la règle.
 */
export function recommendedTeamSize(rule: TeamSizeRule, quantity: number, requested = 0): number {
  const wanted = requested > 0 ? requested : Math.ceil(quantity / Math.max(1, rule.unitsPerAgent));
  return Math.min(rule.maxAgents, Math.max(rule.minAgents, wanted));
}

/** Ce qu'il faut d'une définition pour trouver le champ de la taille d'équipe. */
type WithTeamSize = { fields: FormField[]; pricing: { teamSize: TeamSizeRule } };

/** Champ de la taille d'équipe (champ number actif de la prestation), ou null. */
export function teamSizeField(service: WithTeamSize): FormField | null {
  const code = service.pricing.teamSize.fieldCode;
  return (
    service.fields.find((field) => field.code === code && field.type === 'number' && field.active) ?? null
  );
}

/** Unité de l'ancien formulaire, déduite de l'unité du champ de la taille d'équipe. */
export function legacyUnit(service: WithTeamSize): LegacyUnit {
  const label = (teamSizeField(service)?.unitLabel ?? '').toLowerCase().replace(/\s/g, '');
  if (label === 'm³' || label === 'm3') return 'cubic_meter';
  if (label.startsWith('pièce') || label.startsWith('piece')) return 'room';
  if (label.startsWith('fosse')) return 'septic_tank';
  return 'square_meter';
}

const isCoefficient = (bp: unknown) =>
  Number.isInteger(bp) && (bp as number) >= 1 && (bp as number) <= MAX_COEFFICIENT_BP;
const isOptionalAmount = (value: number | null) => value === null || isWholeAmount(value);
const isOptionalCoefficient = (value: number | null) => value === null || isCoefficient(value);
const hasText = (value: string, max: number) => value.trim().length > 0 && value.length <= max;

/** Prix d'une valeur ou d'une réponse oui : non fixé si supplément et coefficient manquent tous deux. */
export function effectIsSet(supplement: number | null, coefficientBp: number | null): boolean {
  return supplement !== null || coefficientBp !== null;
}

function fieldProblems(fields: FormField[], path: string): string[] {
  const problems: string[] = [];
  const codes = new Set<string>();
  fields.forEach((field, index) => {
    const at = `${path}[${index}]`;
    if (!isCode(field.code) || codes.has(field.code)) problems.push(`${at}.code`);
    codes.add(field.code);
    if (!hasText(field.label, 100)) problems.push(`${at}.label`);
    if (field.helpText !== null && field.helpText.length > 300) problems.push(`${at}.helpText`);
    if (!(FIELD_TYPES as readonly string[]).includes(field.type)) {
      problems.push(`${at}.type`);
      return;
    }
    if (field.type === 'number') {
      if (!field.unitLabel || !hasText(field.unitLabel, 30)) problems.push(`${at}.unitLabel`);
      const bound = (value: number | null) =>
        Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_NUMBER_ANSWER;
      if (!bound(field.min)) problems.push(`${at}.min`);
      if (!bound(field.max) || (bound(field.min) && (field.max as number) < (field.min as number)))
        problems.push(`${at}.max`);
      if (!isOptionalAmount(field.pricePerUnit)) problems.push(`${at}.pricePerUnit`);
    }
    if (field.type === 'choice') {
      if (!field.choices.length || (field.active && !field.choices.some((choice) => choice.active)))
        problems.push(`${at}.choices`);
      const values = new Set<string>();
      field.choices.forEach((choice, position) => {
        const where = `${at}.choices[${position}]`;
        if (!isCode(choice.code) || values.has(choice.code)) problems.push(`${where}.code`);
        values.add(choice.code);
        if (!hasText(choice.label, 100)) problems.push(`${where}.label`);
        if (!isOptionalAmount(choice.supplement)) problems.push(`${where}.supplement`);
        if (!isOptionalCoefficient(choice.coefficientBp)) problems.push(`${where}.coefficientBp`);
      });
    }
    if (field.type === 'boolean') {
      if (!isOptionalAmount(field.supplementIfYes)) problems.push(`${at}.supplementIfYes`);
      if (!isOptionalCoefficient(field.coefficientBpIfYes)) problems.push(`${at}.coefficientBpIfYes`);
    }
  });
  return problems;
}

/** Contrôle d'une définition avant enregistrement ou essai : chemins des propriétés en défaut. */
export function definitionProblems(draft: ServiceDraft): string[] {
  const problems: string[] = [];
  if (!hasText(draft.name, 100)) problems.push('name');
  if (draft.description.length > 1000) problems.push('description');
  if (!draft.fields.some((field) => field.active)) problems.push('fields');
  problems.push(...fieldProblems(draft.fields, 'fields'));

  const options = new Set<string>();
  draft.options.forEach((option, index) => {
    const at = `options[${index}]`;
    if (!isCode(option.code) || options.has(option.code)) problems.push(`${at}.code`);
    options.add(option.code);
    if (!hasText(option.label, 100)) problems.push(`${at}.label`);
    if (option.description !== null && option.description.length > 500) problems.push(`${at}.description`);
    if (!isOptionalAmount(option.flatPrice)) problems.push(`${at}.flatPrice`);
    problems.push(...fieldProblems(option.fields, `${at}.fields`));
  });

  const { pricing } = draft;
  if (!isOptionalAmount(pricing.minimumPrice)) problems.push('pricing.minimumPrice');
  if (!isCoefficient(pricing.defaultCoefficientBp)) problems.push('pricing.defaultCoefficientBp');
  for (const [commune, bp] of Object.entries(pricing.communeCoefficients)) {
    if (!commune || !isCoefficient(bp)) problems.push(`pricing.communeCoefficients.${commune}`);
  }
  const frequencies = new Set<string>();
  pricing.frequencies.forEach((frequency, index) => {
    const at = `pricing.frequencies[${index}]`;
    if (!isCode(frequency.code) || frequencies.has(frequency.code)) problems.push(`${at}.code`);
    frequencies.add(frequency.code);
    if (!hasText(frequency.label, 100)) problems.push(`${at}.label`);
    if (!isCoefficient(frequency.coefficientBp)) problems.push(`${at}.coefficientBp`);
  });
  const { fieldCode, unitsPerAgent, minAgents, maxAgents } = pricing.teamSize;
  if (
    ![unitsPerAgent, minAgents, maxAgents].every((n) => Number.isInteger(n) && n >= 1) ||
    minAgents > maxAgents
  ) {
    problems.push('pricing.teamSize');
  }
  if (
    fieldCode !== null &&
    !draft.fields.some((field) => field.code === fieldCode && field.type === 'number')
  ) {
    problems.push('pricing.teamSize.fieldCode');
  }
  const items = new Set<string>();
  pricing.checklist.forEach((item, index) => {
    if (!isCode(item.code) || items.has(item.code) || !item.label.trim())
      problems.push(`pricing.checklist[${index}]`);
    items.add(item.code);
  });
  return problems;
}

/** Tous les prix nécessaires des champs actifs (hors options) sont fixés : toute réponse est chiffrable. */
export function isFullyPriced(service: Pick<ServiceDefinition, 'fields'>): boolean {
  return service.fields
    .filter((field) => field.active)
    .every((field) => {
      if (field.type === 'number') return field.pricePerUnit !== null;
      if (field.type === 'choice')
        return field.choices
          .filter((choice) => choice.active)
          .every((choice) => effectIsSet(choice.supplement, choice.coefficientBp));
      return effectIsSet(field.supplementIfYes, field.coefficientBpIfYes);
    });
}
