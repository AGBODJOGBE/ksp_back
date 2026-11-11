import {
  expandSchedule,
  type InterventionSchedule,
  legacyRecurrenceOf,
  passageStart,
  type ScheduleMode,
  scheduleFromLegacy,
  scheduleProblem,
  type ScheduleWarning,
  type Weekday,
  type WeekOfMonth,
} from '../../domain/intervention-schedule';
import { type Recurrence } from '../../domain/recurrence';
import { respectsLeadTime, type Slot, slotFrom } from '../../domain/schedule';
import { type CleaningSettings } from '../../domain/settings';
import { type CleaningDeps } from '../deps';
import { CleaningErrors } from './errors';
import { parseRecurrence, parseSlot } from './validation';

/**
 * Plan de passages reçu (ADR-052), au format des messages gRPC : chaîne vide, 0 ou liste vide pour
 * un champ absent ; rangs dans le mois en chaînes ("1" à "4", "last").
 */
export interface ScheduleInput {
  mode: string;
  dates?: string[] | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
  weekdays?: string[] | undefined;
  everyWeeks?: number | undefined;
  monthDays?: number[] | undefined;
  weeksOfMonth?: string[] | undefined;
  startTime?: string | undefined;
  excludedDates?: string[] | undefined;
  extraDates?: string[] | undefined;
}

export type RecurrenceInput = { period: string; visitsPerPeriod: number; durationMonths: number };

/** Plan contrôlé, ses dates exactes et ses avertissements. */
export interface PlannedSchedule {
  schedule: InterventionSchedule;
  dates: string[];
  warnings: ScheduleWarning[];
}

/** Plan facultatif : null si absent (message gRPC absent ou sans mode). */
export function parseSchedule(input: ScheduleInput | null | undefined): InterventionSchedule | null {
  if (!input?.mode) return null;
  return {
    mode: input.mode as ScheduleMode,
    dates: input.dates ?? [],
    startDate: input.startDate || null,
    endDate: input.endDate || null,
    weekdays: (input.weekdays ?? []) as Weekday[],
    everyWeeks: input.everyWeeks || 1,
    monthDays: input.monthDays ?? [],
    weeksOfMonth: (input.weeksOfMonth ?? []).map((rank) =>
      rank === 'last' ? 'last' : Number(rank),
    ) as WeekOfMonth[],
    startTime: input.startTime ?? '',
    excludedDates: input.excludedDates ?? [],
    extraDates: input.extraDates ?? [],
  };
}

/**
 * Dates d'un plan, contrôlées : plan bien formé, au moins un passage et au plus le maximum réglé,
 * premier passage au-delà du délai minimum (CLEANING_LEAD_TIME_TOO_SHORT sinon).
 */
export function planSchedule(
  deps: Pick<CleaningDeps, 'schedules' | 'fieldDates'>,
  schedule: InterventionSchedule,
  settings: Pick<CleaningSettings, 'minimumLeadHours'>,
  now: Date,
): PlannedSchedule {
  const problem = scheduleProblem(schedule, deps.schedules);
  if (problem) throw CleaningErrors.invalid(problem.field, problem.message);
  const { dates, warnings } = expandSchedule(schedule);
  if (!dates.length) {
    throw CleaningErrors.invalid(
      'schedule',
      'Aucun passage dans ce plan : vérifiez la période, les jours choisis et les jours exclus.',
    );
  }
  if (dates.length > deps.schedules.maxVisits) {
    throw CleaningErrors.invalid(
      'schedule',
      `${deps.schedules.maxVisits} passages au plus : ce plan en compte ${dates.length}.`,
    );
  }
  if (!respectsLeadTime(firstStart({ schedule, dates }, deps), now, settings.minimumLeadHours)) {
    throw CleaningErrors.leadTimeTooShort(settings.minimumLeadHours);
  }
  return { schedule, dates, warnings };
}

/** Début du premier passage, dans le fuseau du service. */
export function firstStart(
  planned: Pick<PlannedSchedule, 'schedule' | 'dates'>,
  deps: Pick<CleaningDeps, 'fieldDates'>,
): Date {
  return passageStart(planned.dates[0] as string, planned.schedule.startTime, deps.fieldDates.timeZone);
}

/** Créneau du premier passage, pour une durée donnée. */
export function firstPassageSlot(
  planned: Pick<PlannedSchedule, 'schedule' | 'dates'>,
  durationMinutes: number,
  deps: Pick<CleaningDeps, 'fieldDates'>,
): Slot {
  return slotFrom(firstStart(planned, deps), durationMinutes);
}

/** Durée indicative du créneau souhaité déduit d'un plan : la vraie durée est fixée au devis. */
export const DERIVED_SLOT_MINUTES = 120;
export const MAX_PREFERRED_SLOTS = 3;

/** Dates, plan et récurrence d'une demande, tels qu'enregistrés. */
export interface RequestTiming {
  preferredSlots: Slot[];
  recurrence: Recurrence | null;
  schedule: InterventionSchedule | null;
  scheduledDates: string[];
}

/**
 * Créneaux souhaités et plan de passages d'une demande (seule ou groupée) :
 * - `schedule` (ADR-052) : dates exactes ; créneaux souhaités facultatifs (le premier passage sinon),
 *   récurrence de l'ancien format déduite pour les anciens lecteurs ;
 * - `recurrence` (dépréciée) : traduite en plan quand c'est exact (un passage par semaine ou par
 *   mois, depuis le premier créneau), sinon gardée telle quelle (ancien calcul approximatif) ;
 * - les deux ensemble : refusé.
 */
export function requestTiming(
  deps: Pick<CleaningDeps, 'schedules' | 'fieldDates'>,
  input: {
    preferredSlots: { start: string; end: string }[];
    schedule?: ScheduleInput | null | undefined;
    recurrence?: RecurrenceInput | null | undefined;
  },
  settings: Pick<CleaningSettings, 'minimumLeadHours'>,
  now: Date,
): RequestTiming {
  const schedule = parseSchedule(input.schedule);
  const legacy = parseRecurrence(input.recurrence ?? undefined);
  if (schedule && legacy) {
    throw CleaningErrors.invalid('recurrence', 'Envoyez schedule, ou recurrence (dépréciée), pas les deux.');
  }
  const min = schedule ? 0 : 1;
  if (input.preferredSlots.length < min || input.preferredSlots.length > MAX_PREFERRED_SLOTS) {
    throw CleaningErrors.slotInvalid(`Proposez de ${min} à ${MAX_PREFERRED_SLOTS} créneaux.`);
  }
  const slots = input.preferredSlots.map((slot, index) => parseSlot(`preferredSlots[${index}]`, slot));
  if (slots.some((slot) => !respectsLeadTime(slot.start, now, settings.minimumLeadHours))) {
    throw CleaningErrors.leadTimeTooShort(settings.minimumLeadHours);
  }
  const translated =
    legacy && slots[0] ? scheduleFromLegacy(legacy, slots[0].start, deps.fieldDates.timeZone) : null;
  const plan = schedule ?? translated;
  if (!plan) return { preferredSlots: slots, recurrence: legacy, schedule: null, scheduledDates: [] };
  const planned = planSchedule(deps, plan, settings, now);
  return {
    preferredSlots: slots.length ? slots : [firstPassageSlot(planned, DERIVED_SLOT_MINUTES, deps)],
    recurrence: legacyRecurrenceOf(planned.schedule, planned.dates),
    schedule: planned.schedule,
    scheduledDates: planned.dates,
  };
}

/** Jours d'intervention par semaine : ceux indiqués, sinon ceux d'un plan hebdomadaire, sinon null. */
export function daysPerWeekOf(given: number | null, schedule: InterventionSchedule | null): number | null {
  if (given) return given;
  return schedule?.mode === 'weekly' ? schedule.weekdays.length : null;
}
