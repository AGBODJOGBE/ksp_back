import { type PlanningMode } from '../auto-planning/modes';
import { DEFAULT_SCORE_WEIGHTS, type ScoreWeights } from '../auto-planning/score';

/**
 * Réglages du module (partie 16.1, UC-NT-43, RV-29). Domaine pur : un PATCH est fusionné avec les
 * valeurs en vigueur, puis l'ensemble est validé (bornes de chaque réglage, règles croisées :
 * avertissement < suspension, heures par jour ≤ heures par semaine, poids = 100, rappel < validité ;
 * 0 = aucun rappel). Les bornes sont celles de la contrainte cleaning_settings_bounds_check.
 */
export interface ChecklistPoint {
  code: string;
  label: string;
  order: number;
}

export interface ModuleSettings {
  maxOpenRequests: number;
  minVisitLeadHours: number;
  visitFeePaymentHours: number;
  visitTargetHours: number;
  visitDurationMinutes: number;
  defaultTravelMinutes: number;
  /** Frais de visite par défaut, en FCFA (R-FV-01). */
  defaultVisitFee: number;
  deductVisitFee: boolean;
  quoteValidityDays: number;
  quoteReminderDays: number;
  maxDiscountWithoutApprovalPct: number;
  firstSessionLeadHours: number;
  programMaxMonths: number;
  programMaxSessions: number;
  freeCancellationHours: number;
  maxReschedulesPerMonth: number;
  lateCancellationFeePct: number;
  sessionPaymentGraceHours: number;
  overdueSessionsBeforeSuspension: number;
  balanceGuarantee: boolean;
  unpaidInvoicesWarning: number;
  unpaidInvoicesSuspension: number;
  defaultPlanningMode: PlanningMode;
  planningHorizonDays: number;
  scoreWeights: ScoreWeights;
  assignmentResponseHours: number;
  defaultMaxHoursDay: number;
  defaultMaxHoursWeek: number;
  maxPhotosPerType: number;
  claimWindowHours: number;
  retentionMonths: number;
  commonChecklist: ChecklistPoint[];
  arrivalAlertMeters: number;
  arrivalMaxAdvanceMinutes: number;
  customerWaitMinutes: number;
}

type IntegerSetting = {
  [K in keyof ModuleSettings]: ModuleSettings[K] extends number ? K : never;
}[keyof ModuleSettings];

/** Bornes incluses des réglages entiers (16.1). Les frais de visite par défaut sont seulement ≥ 0. */
export const SETTING_BOUNDS: Readonly<Record<Exclude<IntegerSetting, 'defaultVisitFee'>, [number, number]>> =
  {
    maxOpenRequests: [1, 100],
    minVisitLeadHours: [0, 168],
    visitFeePaymentHours: [1, 168],
    visitTargetHours: [24, 240],
    visitDurationMinutes: [15, 480],
    defaultTravelMinutes: [0, 120],
    quoteValidityDays: [1, 90],
    quoteReminderDays: [0, 30],
    maxDiscountWithoutApprovalPct: [0, 100],
    firstSessionLeadHours: [0, 720],
    programMaxMonths: [1, 60],
    programMaxSessions: [1, 1000],
    freeCancellationHours: [0, 168],
    maxReschedulesPerMonth: [0, 10],
    lateCancellationFeePct: [0, 100],
    sessionPaymentGraceHours: [1, 168],
    overdueSessionsBeforeSuspension: [1, 10],
    unpaidInvoicesWarning: [1, 12],
    unpaidInvoicesSuspension: [1, 12],
    planningHorizonDays: [1, 60],
    assignmentResponseHours: [1, 72],
    defaultMaxHoursDay: [1, 24],
    defaultMaxHoursWeek: [1, 168],
    maxPhotosPerType: [1, 50],
    claimWindowHours: [12, 168],
    retentionMonths: [1, 120],
    arrivalAlertMeters: [50, 5000],
    arrivalMaxAdvanceMinutes: [0, 240],
    customerWaitMinutes: [10, 120],
  };

/** Points communs de la liste de contrôle : 50 au plus (R-EX-09). */
export const MAX_COMMON_CHECKLIST = 50;
const CHECKLIST_CODE = /^[a-z][a-z0-9_]{1,49}$/;
const MAX_LABEL = 200;
const MAX_ORDER = 10_000;
const PLANNING_MODES: readonly PlanningMode[] = ['manual', 'proposal', 'automatic'];

export const DEFAULT_COMMON_CHECKLIST: readonly ChecklistPoint[] = [
  { code: 'arrival', label: 'Arrivée sur place et accueil du client', order: 0 },
  { code: 'cleaning_done', label: 'Prestation réalisée selon le devis', order: 1 },
  { code: 'site_left_clean', label: 'Matériel rangé, déchets évacués', order: 2 },
  { code: 'customer_review', label: 'Tour final avec le client', order: 3 },
];

/** Valeurs par défaut du tableau de 16.1 (celles de la migration). */
export const DEFAULT_SETTINGS: ModuleSettings = {
  maxOpenRequests: 5,
  minVisitLeadHours: 24,
  visitFeePaymentHours: 72,
  visitTargetHours: 72,
  visitDurationMinutes: 60,
  defaultTravelMinutes: 30,
  defaultVisitFee: 0,
  deductVisitFee: true,
  quoteValidityDays: 15,
  quoteReminderDays: 2,
  maxDiscountWithoutApprovalPct: 20,
  firstSessionLeadHours: 48,
  programMaxMonths: 24,
  programMaxSessions: 400,
  freeCancellationHours: 24,
  maxReschedulesPerMonth: 2,
  lateCancellationFeePct: 50,
  sessionPaymentGraceHours: 24,
  overdueSessionsBeforeSuspension: 1,
  balanceGuarantee: false,
  unpaidInvoicesWarning: 1,
  unpaidInvoicesSuspension: 2,
  defaultPlanningMode: 'proposal',
  planningHorizonDays: 14,
  scoreWeights: { ...DEFAULT_SCORE_WEIGHTS },
  assignmentResponseHours: 12,
  defaultMaxHoursDay: 8,
  defaultMaxHoursWeek: 48,
  maxPhotosPerType: 10,
  claimWindowHours: 48,
  retentionMonths: 12,
  commonChecklist: DEFAULT_COMMON_CHECKLIST.map((point) => ({ ...point })),
  arrivalAlertMeters: 300,
  arrivalMaxAdvanceMinutes: 30,
  customerWaitMinutes: 30,
};

export interface SettingProblem {
  field: string;
  reason: 'invalid_type' | 'out_of_range' | 'required' | 'duplicate';
}

function integerProblem(field: string, value: number, min: number, max: number): SettingProblem[] {
  if (!Number.isInteger(value)) return [{ field, reason: 'invalid_type' }];
  return value < min || value > max ? [{ field, reason: 'out_of_range' }] : [];
}

function checklistProblems(points: readonly ChecklistPoint[]): SettingProblem[] {
  if (points.length > MAX_COMMON_CHECKLIST) return [{ field: 'commonChecklist', reason: 'out_of_range' }];
  const problems: SettingProblem[] = [];
  const seen = new Set<string>();
  points.forEach((point, index) => {
    const at = `commonChecklist[${index}]`;
    if (!CHECKLIST_CODE.test(point.code)) problems.push({ field: `${at}.code`, reason: 'invalid_type' });
    else if (seen.has(point.code)) problems.push({ field: `${at}.code`, reason: 'duplicate' });
    seen.add(point.code);
    const label = point.label.trim();
    if (!label) problems.push({ field: `${at}.label`, reason: 'required' });
    else if (label.length > MAX_LABEL) problems.push({ field: `${at}.label`, reason: 'out_of_range' });
    problems.push(...integerProblem(`${at}.order`, point.order, 0, MAX_ORDER));
  });
  return problems;
}

/**
 * Problèmes d'un jeu de réglages complet : bornes, puis règles croisées. Une règle croisée n'est
 * contrôlée que si ses réglages sont déjà dans leurs bornes (un seul motif par réglage).
 */
export function settingsProblems(settings: ModuleSettings): SettingProblem[] {
  const problems: SettingProblem[] = [];
  for (const [field, [min, max]] of Object.entries(SETTING_BOUNDS)) {
    problems.push(...integerProblem(field, settings[field as keyof typeof SETTING_BOUNDS], min, max));
  }
  problems.push(...integerProblem('defaultVisitFee', settings.defaultVisitFee, 0, Number.MAX_SAFE_INTEGER));
  if (!PLANNING_MODES.includes(settings.defaultPlanningMode)) {
    problems.push({ field: 'defaultPlanningMode', reason: 'invalid_type' });
  }
  const weights = Object.entries(settings.scoreWeights).flatMap(([name, weight]) =>
    integerProblem(`scoreWeights.${name}`, weight, 0, 100),
  );
  problems.push(...weights);
  problems.push(...checklistProblems(settings.commonChecklist));

  const flagged = (...fields: string[]) => problems.some((p) => fields.includes(p.field));
  const cross = (field: string, holds: boolean, involved: string[]) => {
    if (!holds && !flagged(...involved)) problems.push({ field, reason: 'out_of_range' });
  };
  cross('unpaidInvoicesWarning', settings.unpaidInvoicesWarning < settings.unpaidInvoicesSuspension, [
    'unpaidInvoicesWarning',
    'unpaidInvoicesSuspension',
  ]);
  cross('defaultMaxHoursDay', settings.defaultMaxHoursDay <= settings.defaultMaxHoursWeek, [
    'defaultMaxHoursDay',
    'defaultMaxHoursWeek',
  ]);
  const total = Object.values(settings.scoreWeights).reduce((sum, weight) => sum + weight, 0);
  if (!weights.length) cross('scoreWeights', total === 100, []);
  cross(
    'quoteReminderDays',
    settings.quoteReminderDays === 0 || settings.quoteReminderDays < settings.quoteValidityDays,
    ['quoteReminderDays', 'quoteValidityDays'],
  );
  return problems;
}

export type SettingsDecision =
  { ok: true; value: ModuleSettings } | { ok: false; problems: SettingProblem[] };

/** PATCH : champs absents inchangés ; l'ensemble fusionné est validé en entier (RV-29). */
export function mergeSettings(current: ModuleSettings, patch: Partial<ModuleSettings>): SettingsDecision {
  const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  const value: ModuleSettings = { ...current, ...defined };
  const problems = settingsProblems(value);
  return problems.length ? { ok: false, problems } : { ok: true, value };
}

/** Avant et après des seuls réglages modifiés, pour le journal d'audit (settings.updated). */
export function settingsChanges(
  before: ModuleSettings,
  after: ModuleSettings,
): { before: Partial<ModuleSettings>; after: Partial<ModuleSettings> } {
  const changed = (Object.keys(after) as (keyof ModuleSettings)[]).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
  return {
    before: Object.fromEntries(changed.map((key) => [key, before[key]])),
    after: Object.fromEntries(changed.map((key) => [key, after[key]])),
  };
}
