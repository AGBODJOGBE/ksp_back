import { type cleaningV1 } from '@ksp/contracts';
import { type SchedulePlanInput } from '../../application/simulation/schedule';
import { type SimulationResult, type ValueInput } from '../../application/simulation/simulate.use-cases';
import { type PriceRange } from '../../domain/pricing/money';
import { type PricingLine } from '../../domain/pricing/offer-price';
import { type SchedulePreview } from '../../domain/schedule-plan/plan';
import { maybeMoney, money } from './catalog.presenters';

/** Valeurs reçues (oneof) : nombre, code de choix ou oui/non ; aucune des trois : valeur vide. */
export function valuesFromProto(
  values: Record<string, cleaningV1.ParameterValue>,
): Record<string, ValueInput> {
  return Object.fromEntries(
    Object.entries(values).map(([code, value]) => [code, value.number ?? value.choice ?? value.flag ?? null]),
  );
}

export function scheduleFromProto(plan: cleaningV1.SchedulePlan | undefined): SchedulePlanInput | undefined {
  if (!plan) return undefined;
  return {
    kind: plan.kind,
    startTime: plan.startTime,
    dates: plan.dates,
    weekdays: plan.weekdays,
    everyWeeks: plan.everyWeeks,
    monthDays: plan.monthDays,
    monthWeekdays: plan.monthWeekdays.map((entry) => ({ rank: entry.rank, weekday: entry.weekday })),
    startDate: plan.startDate,
    endDate: plan.endDate,
    durationWeeks: plan.durationWeeks,
    durationMonths: plan.durationMonths,
    excludedDates: plan.excludedDates,
    addedDates: plan.addedDates,
    excludeHolidays: plan.excludeHolidays,
  };
}

export function presentSchedulePreview(preview: SchedulePreview): cleaningV1.SchedulePreview {
  return {
    occurrences: preview.occurrences.map((occurrence) => ({
      date: occurrence.date,
      start: occurrence.start.toISOString(),
    })),
    count: preview.count,
    firstStart: preview.firstStart?.toISOString(),
    lastStart: preview.lastStart?.toISOString(),
    notices: preview.notices.map((notice) => ({
      code: notice.code,
      date: notice.date,
      label: notice.label ?? undefined,
    })),
  };
}

const range = (value: PriceRange | null): cleaningV1.PriceRange | undefined =>
  value === null ? undefined : { low: money(value.low), high: money(value.high) };

const line = (entry: PricingLine): cleaningV1.PricingLine => ({
  kind: entry.kind,
  label: entry.label,
  parameterCode: entry.parameterCode ?? undefined,
  quantity: entry.quantity ?? undefined,
  unitAmount: maybeMoney(entry.unitAmount),
  coefficientBps: entry.coefficientBps ?? undefined,
  amount: money(entry.amount),
});

/** Résultat du calcul → Simulation ; la ligne « remise pack » suit les lignes de son pack (R-DV-07). */
export function presentSimulation(result: SimulationResult): cleaningV1.Simulation {
  const { pricing } = result;
  const discounts = [...pricing.discountLines];
  return {
    pricing: {
      communeKey: pricing.communeKey ?? undefined,
      communeCoefficientBps: pricing.communeCoefficientBps,
      offers: pricing.offers.map((offer) => ({
        offerId: offer.offerId,
        cleaningTypeId: offer.cleaningTypeId,
        cleaningTypeCode: result.cleaningTypeCodes[offer.cleaningTypeId] ?? '',
        name: offer.name,
        tariffVersion: offer.tariffVersion ?? undefined,
        status: offer.status,
        minimumApplied: offer.minimumApplied,
        price: maybeMoney(offer.price),
        lines: [
          ...offer.lines,
          ...(offer.status === 'priced' && offer.packDiscount > 0 ? discounts.splice(0, 1) : []),
        ].map(line),
        onQuoteReason: offer.onQuoteReason ?? undefined,
        tariffStatus: offer.tariffStatus ?? undefined,
      })),
      complete: pricing.complete,
      packDiscount: pricing.packDiscount > 0 ? money(pricing.packDiscount) : undefined,
      sessionPrice: maybeMoney(pricing.sessionPrice),
      range: range(pricing.range),
      sessionsCount: pricing.sessionsCount ?? undefined,
      programTotal: maybeMoney(pricing.programTotal),
      frequencyDiscount: maybeMoney(pricing.frequencyDiscount),
      visitFee: money(result.visitFee),
      calculatedAt: result.calculatedAt.toISOString(),
      pricedSubtotal: maybeMoney(pricing.pricedSubtotal),
      status: pricing.status,
      programRange: range(pricing.programRange),
      teamSize: pricing.teamSize ?? undefined,
      durationMinutes: pricing.durationMinutes ?? undefined,
    },
    schedule: result.schedule ? presentSchedulePreview(result.schedule) : undefined,
    disclaimer: result.disclaimer,
    covered: pricing.covered,
    communeApplied: pricing.communeApplied,
    notices: pricing.notices,
    usesDrafts: pricing.usesDrafts,
  };
}
