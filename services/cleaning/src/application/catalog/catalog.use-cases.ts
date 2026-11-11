import { type ServiceDefinition } from '../../domain/catalog';
import { calculatePrice, type PriceCalculation } from '../../domain/simulator';
import { isCovered, type Zone } from '../../domain/zone';
import { type CleaningDeps } from '../deps';
import { type ScheduleWarning } from '../../domain/intervention-schedule';
import { GATEWAY_CALLERS, requireCaller } from '../shared/access';
import { CleaningErrors } from '../shared/errors';
import { parseSchedule, type PlannedSchedule, planSchedule, type ScheduleInput } from '../shared/schedules';
import { optionalText } from '../shared/validation';
import { type PricingInput, resolveAnswers } from './pricing-input';

export const ESTIMATE_NOTICE =
  'Estimation non contractuelle : le prix définitif figure dans le devis établi par KSP.';
export const PRICE_NOT_SET_NOTICE =
  "Le prix de cette prestation n'est pas encore publié : demandez un devis, KSP vous répondra.";
export const ANSWERS_INCOMPLETE_NOTICE =
  'Précisez votre besoin pour obtenir une estimation, ou demandez un devis : KSP vous répondra.';
/** Estimation sans commune (ADR-034) : coefficient neutre, prix recalculé à la demande de devis. */
export const NO_COMMUNE_NOTICE =
  'Estimation indicative, sans commune : le prix sera recalculé avec la commune du lieu lors de la demande de devis. Le prix définitif figure dans le devis établi par KSP.';

/** Mention affichée avec un calcul ; `communeApplied` faux : estimation indicative, sans commune. */
export function calculationNotice(calculation: PriceCalculation, communeApplied = true): string {
  if (calculation.priced) return communeApplied ? ESTIMATE_NOTICE : NO_COMMUNE_NOTICE;
  return calculation.reason === 'answers_incomplete' ? ANSWERS_INCOMPLETE_NOTICE : PRICE_NOT_SET_NOTICE;
}

/** Prestation active, sinon introuvable (une prestation désactivée n'existe plus pour le public). */
export async function activeService(deps: CleaningDeps, code: string): Promise<ServiceDefinition> {
  const service = await deps.catalog.findService(code);
  if (!service || !service.active) throw CleaningErrors.serviceNotFound();
  return service;
}

/** UC-CL-01 : catalogue public (le formulaire public est construit sans prix par l'interface). */
export class ListServicesUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(): Promise<ServiceDefinition[]> {
    requireCaller(GATEWAY_CALLERS);
    return (await this.deps.catalog.listServices()).filter((service) => service.active);
  }
}

/** Zones desservies publiques : les seules communes actives, où une demande de devis est acceptée. */
export class ListServedZonesUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(): Promise<Zone[]> {
    requireCaller(GATEWAY_CALLERS);
    return (await this.deps.catalog.listZones()).filter((zone) => zone.active);
  }
}

export interface SimulateInput extends PricingInput {
  serviceCode: string;
  /** Facultative (ADR-034) : vide ou absente, coefficient de commune neutre. */
  commune?: string | null | undefined;
  /** Facultatif (ADR-052) : plan de passages, montant estimé sur le nombre exact de passages. */
  schedule?: ScheduleInput | null | undefined;
}

/** Aperçu d'un plan de passages (ADR-052) : dates exactes, à afficher en calendrier. */
export interface SchedulePreview {
  dates: string[];
  count: number;
  firstDate: string;
  lastDate: string;
  warnings: ScheduleWarning[];
}

export function schedulePreview({ dates, warnings }: PlannedSchedule): SchedulePreview {
  return { dates, count: dates.length, firstDate: dates[0]!, lastDate: dates[dates.length - 1]!, warnings };
}

/** Montant d'un plan : prix d'un passage × nombre de passages, et la fourchette de même. */
export interface ScheduleAmount {
  preview: SchedulePreview;
  /** null si la prestation n'a pas de prix. */
  total: number | null;
  estimate: { low: number; high: number } | null;
}

export interface SimulationResult {
  serviceCode: string;
  calculation: PriceCalculation;
  notice: string;
  /** Commune dans une zone desservie ; l'estimation est donnée dans tous les cas. Faux sans commune. */
  covered: boolean;
  /** Faux sans commune : coefficient neutre, prix indicatif (ADR-034). */
  communeApplied: boolean;
  /** Plan de passages envoyé (ADR-052), null sinon. */
  schedule: ScheduleAmount | null;
}

/** UC-CL-01 : simulateur public. Calcul local, rien n'est enregistré. */
export class SimulateUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: SimulateInput): Promise<SimulationResult> {
    requireCaller(GATEWAY_CALLERS);
    const commune = optionalText('commune', input.commune ?? undefined, 100);
    const service = await activeService(this.deps, input.serviceCode);
    const { value, incomplete } = resolveAnswers(service, input);
    const calculation = calculatePrice(service, { ...value, commune, incomplete });
    const plan = parseSchedule(input.schedule);
    const planned = plan
      ? planSchedule(this.deps, plan, await this.deps.catalog.getSettings(), this.deps.clock.now())
      : null;
    return {
      serviceCode: service.code,
      calculation,
      notice: calculationNotice(calculation, commune !== null),
      covered: commune !== null && isCovered(await this.deps.catalog.listZones(), commune),
      communeApplied: commune !== null,
      schedule: planned ? scheduleAmount(planned, calculation) : null,
    };
  }
}

function scheduleAmount(planned: PlannedSchedule, calculation: PriceCalculation): ScheduleAmount {
  const count = planned.dates.length;
  const { computedPrice, estimate } = calculation;
  return {
    preview: schedulePreview(planned),
    total: calculation.priced && computedPrice !== null ? computedPrice * count : null,
    estimate:
      calculation.priced && estimate ? { low: estimate.low * count, high: estimate.high * count } : null,
  };
}

/**
 * Aperçu public d'un plan de passages (ADR-052) : dates exactes, nombre, premier et dernier passage,
 * avertissements ; mêmes contrôles qu'à la demande de devis. Rien n'est enregistré.
 */
export class PreviewScheduleUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: ScheduleInput | null | undefined): Promise<SchedulePreview> {
    const schedule = parseSchedule(input);
    if (!schedule) throw CleaningErrors.invalid('schedule.mode', 'Mode attendu : dates, weekly ou monthly.');
    const settings = await this.deps.catalog.getSettings();
    return schedulePreview(planSchedule(this.deps, schedule, settings, this.deps.clock.now()));
  }
}
