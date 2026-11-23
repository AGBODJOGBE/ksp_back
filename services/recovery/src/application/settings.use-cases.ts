import { isLocalDay } from '../domain/calendar';
import { DEFAULT_SCALES, type PlanOffer, type PlanScale, scaleProblems } from '../domain/payment-plan';
import { DEFAULT_SCORE_SETTINGS, scoreSettingsProblems } from '../domain/score';
import { DEFAULT_SETTINGS, type RecoverySettings, settingsProblems } from '../domain/settings';
import {
  type AuditLog,
  type Clock,
  type FullSettings,
  type Holiday,
  type HolidayStore,
  type SettingsStore,
  type StoredSettings,
} from './ports';
import {
  BACKOFFICE_MFA_SECONDS,
  CASE_READERS,
  CRITICAL_MFA_SECONDS,
  RECOVERY_ADMINS,
  requireStaff,
} from './shared/access';
import { RecoveryErrors } from './shared/errors';

export interface SettingsDeps {
  settings: SettingsStore;
  holidays: HolidayStore;
  audit: AuditLog;
  clock: Clock;
}

const OFFERS: readonly PlanOffer[] = ['b2b', 'b2c', 'rent'];

/** Réglages par défaut : partie 17.1, barèmes de la partie 6.1, poids du score (R-SD-07). */
export const DEFAULT_FULL_SETTINGS: FullSettings = {
  ...DEFAULT_SETTINGS,
  scales: { ...DEFAULT_SCALES },
  scoreWeights: { ...DEFAULT_SCORE_SETTINGS.weights },
};

/**
 * Réglages enregistrés complétés par les valeurs par défaut : un réglage ajouté plus tard au contrat
 * prend sa valeur par défaut tant que l'admin ne l'a pas modifié.
 */
export async function loadSettings(store: SettingsStore): Promise<StoredSettings> {
  const stored = await store.load();
  if (!stored) return { settings: DEFAULT_FULL_SETTINGS, updatedAt: null, updatedBy: null };
  const values = (stored.values ?? {}) as Partial<FullSettings>;
  const scales = { ...DEFAULT_SCALES, ...(values.scales ?? {}) } as Record<PlanOffer, PlanScale>;
  return {
    settings: {
      ...DEFAULT_FULL_SETTINGS,
      ...values,
      scales,
      scoreWeights: { ...DEFAULT_SCORE_SETTINGS.weights, ...(values.scoreWeights ?? {}) },
    },
    updatedAt: stored.updatedAt,
    updatedBy: stored.updatedBy,
  };
}

/** Problèmes de réglages complets : bornes de la partie 17.1, barèmes et poids du score. */
export function fullSettingsProblems(settings: FullSettings): { field: string; message: string }[] {
  const problems: { field: string; message: string }[] = [];
  const base: RecoverySettings = { ...settings };
  for (const message of settingsProblems(base)) {
    problems.push({ field: message.split(' ')[0]!.replace(/[^A-Za-z]/g, ''), message });
  }
  for (const offer of OFFERS) {
    for (const message of scaleProblems(settings.scales[offer])) {
      problems.push({ field: `default${offer[0]!.toUpperCase()}${offer.slice(1)}Scale`, message });
    }
  }
  for (const message of scoreSettingsProblems({
    ...DEFAULT_SCORE_SETTINGS,
    weights: settings.scoreWeights,
  })) {
    problems.push({ field: 'scoreWeights', message });
  }
  return problems;
}

/** Réglages du recouvrement (GetRecoverySettings) : administrateurs du métier. */
export class GetSettingsUseCase {
  constructor(private readonly deps: SettingsDeps) {}

  async execute(): Promise<StoredSettings> {
    requireStaff(RECOVERY_ADMINS, BACKOFFICE_MFA_SECONDS, this.deps.clock.now().getTime());
    return loadSettings(this.deps.settings);
  }
}

/**
 * Modification des réglages (UpdateRecoverySettings, partie 17.1) : tous les réglages sont envoyés,
 * chacun dans ses bornes (`RECOVERY_SETTING_OUT_OF_BOUNDS`). Action sensible : double
 * authentification de moins de 10 minutes, tracée dans le journal d'audit.
 */
export class UpdateSettingsUseCase {
  constructor(private readonly deps: SettingsDeps) {}

  async execute(input: { settings: FullSettings }): Promise<StoredSettings> {
    const now = this.deps.clock.now();
    const staff = requireStaff(RECOVERY_ADMINS, CRITICAL_MFA_SECONDS, now.getTime());
    const problems = fullSettingsProblems(input.settings);
    if (problems.length > 0) {
      const [first] = problems;
      throw RecoveryErrors.settingOutOfBounds(first!.field, problems.map((p) => p.message).join(' ; '));
    }
    const before = await loadSettings(this.deps.settings);
    await this.deps.settings.save(input.settings, staff.userId, now);
    await this.deps.audit.record({
      actorId: staff.userId,
      action: 'settings.updated',
      entityType: 'recovery_settings',
      entityId: 'recovery',
      details: { changed: changedKeys(before.settings, input.settings) },
    });
    return { settings: input.settings, updatedAt: now, updatedBy: staff.userId };
  }
}

function changedKeys(before: FullSettings, after: FullSettings): string[] {
  return (Object.keys(after) as (keyof FullSettings)[]).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}

const MIN_YEAR = 2000;
const MAX_YEAR = 2100;
const MAX_HOLIDAYS_PER_YEAR = 40;

function requireYear(year: number): number {
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
    throw RecoveryErrors.invalid('year', `Année attendue, de ${MIN_YEAR} à ${MAX_YEAR}.`);
  }
  return year;
}

/** Jours fériés d'une année (ListHolidays) : tout le personnel du recouvrement. */
export class ListHolidaysUseCase {
  constructor(private readonly deps: SettingsDeps) {}

  async execute(input: { year: number }): Promise<Holiday[]> {
    requireStaff(CASE_READERS, BACKOFFICE_MFA_SECONDS, this.deps.clock.now().getTime());
    return this.deps.holidays.listYear(requireYear(input.year));
  }
}

/**
 * Jours fériés d'une année (SetHolidays) : la liste remplace la précédente. Dates de l'année, sans
 * doublon, libellé de 1 à 100 caractères.
 */
export class SetHolidaysUseCase {
  constructor(private readonly deps: SettingsDeps) {}

  async execute(input: { year: number; holidays: readonly Holiday[] }): Promise<Holiday[]> {
    const staff = requireStaff(RECOVERY_ADMINS, BACKOFFICE_MFA_SECONDS, this.deps.clock.now().getTime());
    const year = requireYear(input.year);
    if (input.holidays.length > MAX_HOLIDAYS_PER_YEAR) {
      throw RecoveryErrors.invalid('holidays', `${MAX_HOLIDAYS_PER_YEAR} jours fériés au plus par année.`);
    }
    const seen = new Set<string>();
    const holidays = input.holidays.map((holiday, index) => {
      const date = holiday.date?.trim() ?? '';
      if (!isLocalDay(date) || !date.startsWith(`${year}-`)) {
        throw RecoveryErrors.invalid(`holidays[${index}].date`, `Date de ${year} attendue, AAAA-MM-JJ.`);
      }
      if (seen.has(date)) throw RecoveryErrors.invalid(`holidays[${index}].date`, 'Date en double.');
      seen.add(date);
      const label = holiday.label?.trim() ?? '';
      if (label.length < 1 || label.length > 100) {
        throw RecoveryErrors.invalid(`holidays[${index}].label`, 'Libellé de 1 à 100 caractères.');
      }
      return { date, label };
    });
    holidays.sort((a, b) => a.date.localeCompare(b.date));
    await this.deps.holidays.replaceYear(year, holidays);
    await this.deps.audit.record({
      actorId: staff.userId,
      action: 'holidays.set',
      entityType: 'holidays',
      entityId: String(year),
      details: { count: holidays.length },
    });
    return holidays;
  }
}
