import { isAmount, isCoefficientBps } from '../pricing/money';
import { MAX_NUMBER_VALUE } from '../pricing/tariff-validation';
import { teamRuleProblems } from '../pricing/team';
import { type ParameterKind, type TeamRuleBracket } from '../pricing/types';

/**
 * Contrôle des éléments du catalogue saisis au back-office (partie 4, R-CA-01, R-CA-06, R-CA-09,
 * R-CA-11, R-CA-13, R-CA-14 ; reprise RV-27) : textes rognés et bornés, codes stables, montants et
 * coefficients bornés. Chaque défaut donne un champ et une raison de `CLEANING_VALIDATION_FAILED`.
 * Bornes reprises du contrat OpenAPI.
 */
export type EntryProblemReason =
  | 'required'
  | 'invalid_type'
  | 'out_of_range'
  | 'duplicate'
  | 'not_applicable'
  | 'area_parameter_invalid'
  | 'team_rule_gap';

export interface EntryProblem {
  field: string;
  reason: EntryProblemReason;
}

const CODE = /^[a-z][a-z0-9_]{1,49}$/;
const COMMUNE_KEY = /^[a-z][a-z0-9-]{1,99}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_DISPLAY_ORDER = 10_000;
export const MAX_ENTRY_PARAMETERS = 30;
export const MAX_CHOICES = 30;
export const MAX_CHECKLIST_ITEMS = 50;
export const MAX_REFERENCE_DURATION_MINUTES = 1440;
export const PLANNING_MODES = ['manual', 'proposal', 'automatic'] as const;
export type PlanningMode = (typeof PLANNING_MODES)[number];

export const isCode = (value: string) => CODE.test(value);

/** Texte : déjà rogné par l'appelant ; obligatoire non vide, ou facultatif, et borné. */
function text(field: string, value: string | null, max: number, required: boolean): EntryProblem[] {
  if (value === null || value === '') return required ? [{ field, reason: 'required' }] : [];
  return value.length > max ? [{ field, reason: 'out_of_range' }] : [];
}

const code = (field: string, value: string): EntryProblem[] =>
  CODE.test(value) ? [] : [{ field, reason: 'invalid_type' }];

const integer = (field: string, value: number | null, min: number, max: number): EntryProblem[] =>
  value === null || (Number.isInteger(value) && value >= min && value <= max)
    ? []
    : [{ field, reason: 'out_of_range' }];

const amount = (field: string, value: number | null): EntryProblem[] =>
  value === null || isAmount(value) ? [] : [{ field, reason: 'out_of_range' }];

/** Identifiants d'une liste : pas de doublon, au plus `max`. */
function idList(field: string, ids: readonly string[], max: number): EntryProblem[] {
  const problems: EntryProblem[] = ids.length > max ? [{ field, reason: 'out_of_range' }] : [];
  const seen = new Set<string>();
  ids.forEach((id, index) => {
    if (seen.has(id)) problems.push({ field: `${field}[${index}]`, reason: 'duplicate' });
    seen.add(id);
  });
  return problems;
}

// --- Catégorie, compétence, jour férié -------------------------------------------------------------

export interface CategoryEntry {
  code: string;
  name: string;
  icon: string | null;
  order: number;
  /** Frais de visite de la catégorie (R-FV-01) ; null : valeur par défaut des réglages. */
  visitFee: number | null;
}

export function categoryProblems(entry: CategoryEntry): EntryProblem[] {
  return [
    ...code('code', entry.code),
    ...text('name', entry.name, 100, true),
    ...text('icon', entry.icon, 50, false),
    ...integer('order', entry.order, 0, MAX_DISPLAY_ORDER),
    ...amount('visitFee', entry.visitFee),
  ];
}

export function skillProblems(entry: { code: string; name: string }): EntryProblem[] {
  return [...code('code', entry.code), ...text('name', entry.name, 100, true)];
}

/** Jour férié : date civile AAAA-MM-JJ valide (2027-02-30 refusé), nom obligatoire. */
export function holidayProblems(entry: { date: string; name: string }): EntryProblem[] {
  const parsed = new Date(`${entry.date}T00:00:00Z`);
  const valid = DAY.test(entry.date) && parsed.toISOString().slice(0, 10) === entry.date;
  return [
    ...(valid ? [] : [{ field: 'date', reason: 'invalid_type' as const }]),
    ...text('name', entry.name, 100, true),
  ];
}

// --- Paramètre (R-CA-01, R-CA-02, R-CA-06, R-CA-11) ------------------------------------------------

export interface ChoiceEntry {
  code: string;
  label: string;
  active: boolean;
}

export interface ParameterEntry {
  code: string;
  label: string;
  kind: ParameterKind;
  unit: string | null;
  min: number | null;
  max: number | null;
  choices: ChoiceEntry[];
  help: string | null;
}

/**
 * Nombre : unité obligatoire, bornes de 0 à 1 000 000 (min ≤ max). Choix : au moins une valeur
 * active, codes uniques. Unité, bornes et valeurs ne s'appliquent qu'à leur nature.
 */
export function parameterProblems(entry: ParameterEntry): EntryProblem[] {
  const problems = [
    ...code('code', entry.code),
    ...text('label', entry.label, 100, true),
    ...text('help', entry.help, 300, false),
  ];
  if (entry.kind === 'number') {
    problems.push(...text('unit', entry.unit, 20, true));
    problems.push(
      ...integer('min', entry.min, 0, MAX_NUMBER_VALUE),
      ...integer('max', entry.max, 0, MAX_NUMBER_VALUE),
    );
    if (entry.min !== null && entry.max !== null && entry.min > entry.max) {
      problems.push({ field: 'max', reason: 'out_of_range' });
    }
  } else {
    for (const field of ['unit', 'min', 'max'] as const) {
      if (entry[field] !== null) problems.push({ field, reason: 'not_applicable' });
    }
  }
  if (entry.kind !== 'choice') {
    if (entry.choices.length) problems.push({ field: 'choices', reason: 'not_applicable' });
    return problems;
  }
  if (!entry.choices.some((choice) => choice.active)) problems.push({ field: 'choices', reason: 'required' });
  if (entry.choices.length > MAX_CHOICES) problems.push({ field: 'choices', reason: 'out_of_range' });
  const seen = new Set<string>();
  entry.choices.forEach((choice, index) => {
    const at = `choices[${index}]`;
    if (!CODE.test(choice.code)) problems.push({ field: `${at}.code`, reason: 'invalid_type' });
    else if (seen.has(choice.code)) problems.push({ field: `${at}.code`, reason: 'duplicate' });
    seen.add(choice.code);
    problems.push(...text(`${at}.label`, choice.label, 100, true));
  });
  return problems;
}

/** Ce qui retire quelque chose à un paramètre utilisé (R-CA-11, `CLEANING_PARAMETER_IN_USE`). */
export type ParameterNarrowing = 'bounds_tightened' | 'choice_removed' | 'deactivated';

export function parameterNarrowing(
  before: Pick<ParameterEntry, 'min' | 'max' | 'choices'> & { active: boolean },
  after: Pick<ParameterEntry, 'min' | 'max' | 'choices'> & { active: boolean },
): ParameterNarrowing[] {
  const narrowing: ParameterNarrowing[] = [];
  const low = (value: number | null) => value ?? 0;
  const high = (value: number | null) => value ?? MAX_NUMBER_VALUE;
  if (low(after.min) > low(before.min) || high(after.max) < high(before.max))
    narrowing.push('bounds_tightened');
  const kept = new Set(after.choices.map((choice) => choice.code));
  if (before.choices.some((choice) => !kept.has(choice.code))) narrowing.push('choice_removed');
  if (before.active && !after.active) narrowing.push('deactivated');
  return narrowing;
}

// --- Lieu (R-CA-01, R-CA-05, R-CA-14) --------------------------------------------------------------

/** Paramètre cité par un lieu ou une offre. */
export interface ParameterRef {
  id: string;
  kind: ParameterKind;
  active: boolean;
}

export interface PlaceTypeEntry {
  code: string;
  name: string;
  icon: string | null;
  description: string | null;
  order: number;
  /** Lieu « Autre » (R-CA-05). */
  isOther: boolean;
  parameters: readonly ParameterRef[];
  areaParameterId: string | null;
}

/**
 * La superficie est obligatoire sauf pour un lieu « Autre » (R-CA-01) : paramètre nombre, actif,
 * parmi ceux du lieu (R-CA-14, `area_parameter_invalid`).
 */
export function placeTypeProblems(entry: PlaceTypeEntry): EntryProblem[] {
  const problems = [
    ...code('code', entry.code),
    ...text('name', entry.name, 100, true),
    ...text('icon', entry.icon, 50, false),
    ...text('description', entry.description, 1000, false),
    ...integer('order', entry.order, 0, MAX_DISPLAY_ORDER),
    ...idList(
      'parameterIds',
      entry.parameters.map((parameter) => parameter.id),
      MAX_ENTRY_PARAMETERS,
    ),
  ];
  if (entry.areaParameterId === null) {
    if (!entry.isOther) problems.push({ field: 'areaParameterId', reason: 'required' });
    return problems;
  }
  const area = entry.parameters.find((parameter) => parameter.id === entry.areaParameterId);
  if (!area || area.kind !== 'number' || !area.active) {
    problems.push({ field: 'areaParameterId', reason: 'area_parameter_invalid' });
  }
  return problems;
}

// --- Type de nettoyage (R-CA-04, R-CA-09) ----------------------------------------------------------

export interface ChecklistItemEntry {
  code: string;
  label: string;
  order: number;
}

export interface CleaningTypeEntry {
  code: string;
  name: string;
  description: string | null;
  icon: string | null;
  isPack: boolean;
  /** Compétence exigée (R-CA-09) ; un pack n'en porte pas (union des compétences de ses types). */
  requiredSkillCode: string | null;
  referenceDurationMinutes: number;
  checklist: readonly ChecklistItemEntry[];
}

export function cleaningTypeProblems(entry: CleaningTypeEntry): EntryProblem[] {
  const problems = [
    ...code('code', entry.code),
    ...text('name', entry.name, 100, true),
    ...text('description', entry.description, 1000, false),
    ...text('icon', entry.icon, 50, false),
  ];
  if (entry.isPack && entry.requiredSkillCode !== null) {
    problems.push({ field: 'requiredSkillCode', reason: 'not_applicable' });
  } else if (!entry.isPack) {
    if (entry.requiredSkillCode === null) problems.push({ field: 'requiredSkillCode', reason: 'required' });
    else problems.push(...code('requiredSkillCode', entry.requiredSkillCode));
  }
  if (!Number.isInteger(entry.referenceDurationMinutes)) {
    problems.push({ field: 'referenceDurationMinutes', reason: 'invalid_type' });
  } else {
    problems.push(
      ...integer(
        'referenceDurationMinutes',
        entry.referenceDurationMinutes,
        1,
        MAX_REFERENCE_DURATION_MINUTES,
      ),
    );
  }
  if (entry.checklist.length > MAX_CHECKLIST_ITEMS)
    problems.push({ field: 'checklist', reason: 'out_of_range' });
  const seen = new Set<string>();
  entry.checklist.forEach((item, index) => {
    const at = `checklist[${index}]`;
    if (!CODE.test(item.code)) problems.push({ field: `${at}.code`, reason: 'invalid_type' });
    else if (seen.has(item.code)) problems.push({ field: `${at}.code`, reason: 'duplicate' });
    seen.add(item.code);
    problems.push(
      ...text(`${at}.label`, item.label, 200, true),
      ...integer(`${at}.order`, item.order, 0, MAX_DISPLAY_ORDER),
    );
  });
  return problems;
}

// --- Offre (R-CA-02, R-CA-10, R-CA-13) -------------------------------------------------------------

export interface OfferEntry {
  extraParameterIds: readonly string[];
  teamRule: readonly TeamRuleBracket[];
  order: number;
}

export function offerProblems(entry: OfferEntry): EntryProblem[] {
  return [
    ...idList('extraParameterIds', entry.extraParameterIds, MAX_ENTRY_PARAMETERS),
    ...teamRuleProblems(entry.teamRule),
    ...integer('order', entry.order, 0, MAX_DISPLAY_ORDER),
  ];
}

// --- Zone (partie 4, R-FV-01, R-PL-05) -------------------------------------------------------------

export interface ZoneEntry {
  communeKey: string;
  name: string;
  coefficientBps: number;
  visitFeeSurcharge: number | null;
  planningMode: string | null;
}

export function zoneProblems(entry: ZoneEntry): EntryProblem[] {
  const problems = [
    ...text('name', entry.name, 100, true),
    ...amount('visitFeeSurcharge', entry.visitFeeSurcharge),
  ];
  if (!COMMUNE_KEY.test(entry.communeKey)) problems.push({ field: 'communeKey', reason: 'invalid_type' });
  if (!isCoefficientBps(entry.coefficientBps))
    problems.push({ field: 'coefficientBps', reason: 'out_of_range' });
  if (entry.planningMode !== null && !(PLANNING_MODES as readonly string[]).includes(entry.planningMode)) {
    problems.push({ field: 'planningMode', reason: 'invalid_type' });
  }
  return problems;
}
