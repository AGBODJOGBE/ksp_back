import { BASIS_POINTS } from '../../domain/pricing/money';
import { frequencyKeyOf } from '../../domain/pricing/frequency';
import { type ParameterLabels } from '../../domain/pricing/offer-price';
import {
  type CommuneInput,
  priceSession,
  type SessionOffer,
  type SessionPricing,
} from '../../domain/pricing/session-price';
import { type ParameterValues } from '../../domain/pricing/types';
import { selectionProblems, withAbsentBooleansAsNo } from '../../domain/pricing/values';
import { type SchedulePreview } from '../../domain/schedule-plan/plan';
import { type Parameter, type TariffVersion } from '../catalog/catalog.ports';
import { type CleaningDeps } from '../deps';
import { requireStaff } from '../shared/access';
import { CleaningErrors, throwFirstProblem } from '../shared/errors';
import { previewSchedule, type SchedulePlanInput, toSchedulePlan } from './schedule';

/**
 * Simulateur (partie 5, R-PX-01 à R-PX-09, R-CA-05, R-CA-08, R-CA-13) : le calcul du domaine, côté
 * serveur, sur le catalogue en vigueur. Public : lieu, offres et types actifs, versions publiées.
 * Back-office (simulateur de test) : éléments inactifs acceptés, brouillons demandés à la place des
 * versions publiées ; un calcul n'est jamais enregistré. Estimation non contractuelle.
 */
export const SIMULATION_DISCLAIMER = 'Estimation non contractuelle, confirmée après la visite des lieux';

/** Valeur reçue : nombre, code de choix, oui/non ; null : valeur vide (refusée, `invalid_type`). */
export type ValueInput = number | string | boolean | null;

export interface SimulationInput {
  placeTypeId: string;
  cleaningTypeIds: string[];
  values: Record<string, ValueInput>;
  schedule?: SchedulePlanInput | undefined;
  communeKey?: string | undefined;
}

export interface SimulationResult {
  pricing: SessionPricing;
  schedule: SchedulePreview | null;
  /** Frais de visite à prévoir : catégorie (ou défaut), plus la majoration d'une commune desservie. */
  visitFee: number;
  calculatedAt: Date;
  disclaimer: string;
  /** Code de chaque type de nettoyage chiffré, par identifiant. */
  cleaningTypeCodes: Record<string, string>;
}

interface Mode {
  acceptInactive: boolean;
  draftTariffIds: readonly string[];
}

const labelsOf = (parameters: readonly Parameter[]): ParameterLabels =>
  Object.fromEntries(
    parameters.map((parameter) => [
      parameter.code,
      {
        label: parameter.label,
        unit: parameter.unit,
        choices: Object.fromEntries(parameter.choices.map((choice) => [choice.code, choice.label])),
      },
    ]),
  );

export async function simulate(
  deps: CleaningDeps,
  input: SimulationInput,
  mode: Mode,
): Promise<SimulationResult> {
  const placeType = await deps.places.getPlaceType(input.placeTypeId);
  if (!placeType) throw CleaningErrors.placeTypeNotFound();
  const [category, parameters, offers, types, settings, zone] = await Promise.all([
    deps.places.getCategory(placeType.categoryId),
    deps.parameters.listParameters(),
    deps.offers.listOffers({ placeTypeId: placeType.id }),
    deps.cleaningTypes.listCleaningTypes(),
    deps.settings.catalogSettings(),
    input.communeKey ? deps.zones.findByCommune(input.communeKey) : Promise.resolve(null),
  ]);
  if (!mode.acceptInactive && (!placeType.active || !category?.active))
    throw CleaningErrors.placeTypeNotFound();
  if (placeType.isOther) throw CleaningErrors.offerNotAvailable(input.cleaningTypeIds[0] ?? '');
  if (!input.cleaningTypeIds.length) throw CleaningErrors.validation('cleaningTypeIds', 'required');

  const parameterById = new Map(parameters.map((parameter) => [parameter.id, parameter]));
  const typeById = new Map(types.map((type) => [type.id, type]));
  const offerOfType = new Map(offers.map((offer) => [offer.cleaningTypeId, offer]));
  const linked = (links: readonly { parameterId: string }[]) =>
    links
      .map((link) => parameterById.get(link.parameterId))
      .filter((parameter): parameter is Parameter => !!parameter);

  const selected = input.cleaningTypeIds.map((typeId) => {
    const offer = offerOfType.get(typeId);
    const type = typeById.get(typeId);
    if (!offer || !type || (!mode.acceptInactive && (!offer.active || !type.active))) {
      throw CleaningErrors.offerNotAvailable(typeId);
    }
    return { offer, type, extraParameters: linked(offer.extraParameters) };
  });
  const placeParameters = linked(placeType.parameters);
  throwFirstProblem(
    selectionProblems({
      selected: selected.map(({ type, extraParameters }) => ({
        cleaningTypeId: type.id,
        packItemIds: type.isPack ? type.packItemIds : [],
        extraParameters,
      })),
      placeParameters,
      values: input.values,
      acceptInactive: mode.acceptInactive,
    }),
  );

  const schedulePlan = input.schedule ? toSchedulePlan(input.schedule) : null;
  const [schedule, tariffs] = await Promise.all([
    schedulePlan ? previewSchedule(deps, schedulePlan) : Promise.resolve(null),
    tariffsOf(
      deps,
      offers.map((offer) => offer.id),
      mode.draftTariffIds,
    ),
  ]);

  const tariffFor = (offerId: string | undefined) => (offerId ? (tariffs.get(offerId) ?? null) : null);
  const sessionOffers: SessionOffer[] = selected.map(({ offer, type }) => {
    const tariff = tariffFor(offer.id);
    return {
      offerId: offer.id,
      cleaningTypeId: type.id,
      name: type.name,
      tariff,
      tariffStatus: tariff === null ? null : tariff.status === 'draft' ? 'draft' : 'published',
      teamRule: offer.teamRule,
      referenceDurationMinutes: type.referenceDurationMinutes,
      packItems: type.isPack
        ? type.packItemIds.map((itemId) => ({
            name: typeById.get(itemId)?.name ?? itemId,
            tariff: tariffFor(offerOfType.get(itemId)?.id),
          }))
        : [],
    };
  });
  const asked = [...placeParameters, ...selected.flatMap((entry) => entry.extraParameters)];
  const commune: CommuneInput | null = input.communeKey
    ? {
        key: input.communeKey,
        coefficientBps: zone?.coefficientBps ?? BASIS_POINTS,
        served: zone?.active ?? false,
      }
    : null;
  const pricing = priceSession({
    offers: sessionOffers,
    values: withAbsentBooleansAsNo(asked, input.values as ParameterValues),
    labels: labelsOf(asked),
    areaParameterCode: parameterById.get(placeType.areaParameterId ?? '')?.code ?? null,
    commune,
    frequencyKey: schedulePlan
      ? frequencyKeyOf({ kind: schedulePlan.kind, everyWeeks: schedulePlan.everyWeeks })
      : null,
    sessionsCount: schedule?.count ?? null,
  });
  const surcharge = pricing.covered ? (zone?.visitFeeSurcharge ?? 0) : 0;
  return {
    pricing,
    schedule,
    visitFee: (category?.visitFee ?? settings.defaultVisitFee) + surcharge,
    calculatedAt: deps.clock.now(),
    disclaimer: SIMULATION_DISCLAIMER,
    cleaningTypeCodes: Object.fromEntries(selected.map(({ type }) => [type.id, type.code])),
  };
}

/**
 * Version retenue de chaque offre du lieu : la publiée, ou le brouillon demandé (simulateur de test).
 * Un brouillon inconnu, déjà publié ou d'une offre d'un autre lieu : CLEANING_TARIFF_NOT_FOUND.
 */
async function tariffsOf(
  deps: CleaningDeps,
  offerIds: readonly string[],
  draftIds: readonly string[],
): Promise<Map<string, TariffVersion>> {
  const [versions, drafts] = await Promise.all([
    deps.offers.listTariffs(offerIds),
    draftIds.length ? deps.offers.getTariffsByIds(draftIds) : Promise.resolve([]),
  ]);
  const retained = new Map(
    versions.filter((tariff) => tariff.status === 'published').map((tariff) => [tariff.offerId, tariff]),
  );
  for (const id of draftIds) {
    const draft = drafts.find((tariff) => tariff.id === id);
    if (!draft || draft.status !== 'draft' || !offerIds.includes(draft.offerId))
      throw CleaningErrors.tariffNotFound();
    retained.set(draft.offerId, draft);
  }
  return retained;
}

/** UC-NT-01 — Simuler un prix, public et sans compte. */
export class SimulateUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  execute(input: SimulationInput): Promise<SimulationResult> {
    return simulate(this.deps, input, { acceptInactive: false, draftTariffIds: [] });
  }
}

/** UC-NT-28 — Tester un tarif dans le simulateur du back-office (R-CA-08). */
export class SimulateWithDraftsUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: SimulationInput & { draftTariffIds: string[] }): Promise<SimulationResult> {
    requireStaff();
    return simulate(this.deps, input, { acceptInactive: true, draftTariffIds: input.draftTariffIds });
  }
}

/** UC-NT-02 — Aperçu des dates d'un programme, public. */
export class PreviewScheduleUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { schedule?: SchedulePlanInput | undefined }): Promise<SchedulePreview> {
    if (!input.schedule) throw CleaningErrors.validation('schedule', 'required');
    return previewSchedule(this.deps, toSchedulePlan(input.schedule));
  }
}
