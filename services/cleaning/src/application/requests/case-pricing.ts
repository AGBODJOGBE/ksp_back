import { type ParameterValue } from '../../domain/pricing/types';
import { parameterPriceEffects } from '../../domain/quotes/quote-lines';
import { type SchedulePlan } from '../../domain/schedule-plan/plan';
import { type CleaningDeps } from '../deps';
import { type SchedulePlanInput } from '../simulation/schedule';
import { simulate, type SimulationResult } from '../simulation/simulate.use-cases';
import { CleaningErrors } from '../shared/errors';
import { type CaseRecord } from './requests.ports';

/**
 * Chiffrage d'un dossier par le domaine du prix (lot A), aux tarifs publiés du jour, avec la commune
 * du dossier (R-DM-03, R-CS-02, R-CS-04). Un type déjà présent dans la demande reste chiffrable même
 * si son offre a été désactivée ; un type ajouté par la supervision doit avoir une offre active.
 */
export function planInput(plan: SchedulePlan): SchedulePlanInput {
  return {
    kind: plan.kind,
    startTime: plan.startTime,
    dates: plan.dates,
    weekdays: plan.weekdays,
    everyWeeks: plan.everyWeeks ?? undefined,
    monthDays: plan.monthDays,
    monthWeekdays: plan.monthWeekdays,
    startDate: plan.startDate ?? undefined,
    endDate: plan.endDate ?? undefined,
    durationWeeks: plan.durationWeeks ?? undefined,
    durationMonths: plan.durationMonths ?? undefined,
    excludedDates: plan.excludedDates,
    addedDates: plan.addedDates,
    excludeHolidays: plan.excludeHolidays ?? undefined,
  };
}

export async function priceCase(
  deps: CleaningDeps,
  record: CaseRecord,
  input: { values: Record<string, ParameterValue>; cleaningTypeIds: string[]; schedule?: SchedulePlan },
): Promise<SimulationResult> {
  const added = input.cleaningTypeIds.filter((id) => !record.request.cleaningTypeIds.includes(id));
  if (added.length) {
    const [offers, types] = await Promise.all([
      deps.offers.listOffers({ placeTypeId: record.request.placeTypeId }),
      deps.cleaningTypes.listCleaningTypes(),
    ]);
    for (const typeId of added) {
      const offer = offers.find((item) => item.cleaningTypeId === typeId);
      const type = types.find((item) => item.id === typeId);
      if (!offer?.active || !type?.active) throw CleaningErrors.offerNotAvailable(typeId);
    }
  }
  return simulate(
    deps,
    {
      placeTypeId: record.request.placeTypeId,
      cleaningTypeIds: input.cleaningTypeIds,
      values: input.values,
      schedule: planInput(input.schedule ?? record.request.schedulePlan),
      communeKey: record.request.communeKey,
    },
    { acceptInactive: true, draftTariffIds: [] },
  );
}

/** Prix d'une séance d'un calcul, ou null s'il n'est pas complet (offre « sur devis »). */
export const sessionPriceOf = (result: SimulationResult): number | null =>
  result.pricing.complete ? result.pricing.sessionPrice : null;

/**
 * R-CS-02 : effet de chaque paramètre changé sur le prix d'une séance, mesuré seul à partir du
 * déclaré (domaine `parameterPriceEffects`). Chaque variante est chiffrée d'avance ; une variante qui
 * ne se chiffre pas n'a pas d'effet.
 */
export async function priceEffects(
  deps: CleaningDeps,
  record: CaseRecord,
  retained: Record<string, ParameterValue>,
): Promise<Record<string, number>> {
  const declared = record.request.declaredValues;
  const types = record.request.cleaningTypeIds;
  const prices = new Map<string, number | null>();
  const keyOf = (values: Record<string, ParameterValue>) => JSON.stringify(Object.entries(values).sort());
  const variants = [
    { ...declared },
    ...Object.keys(retained)
      .filter((code) => declared[code] !== retained[code])
      .map((code) => ({ ...declared, [code]: retained[code] as ParameterValue })),
  ];
  for (const values of variants) {
    try {
      prices.set(
        keyOf(values),
        sessionPriceOf(await priceCase(deps, record, { values, cleaningTypeIds: types })),
      );
    } catch {
      prices.set(keyOf(values), null);
    }
  }
  return parameterPriceEffects(declared, retained, (values) => prices.get(keyOf(values)) ?? null);
}
