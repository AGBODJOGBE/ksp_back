import { type cleaningV1, type moneyV1 } from '@ksp/contracts';
import {
  type CleaningType,
  type Holiday,
  type Parameter,
  type PlaceCategory,
  type Skill,
  type TariffVersion,
} from '../../application/catalog/catalog.ports';
import { type OfferView } from '../../application/catalog/offers.use-cases';
import { type PlaceTypeView } from '../../application/catalog/places.use-cases';
import { type CommuneOption, type ZoneView } from '../../application/catalog/zones.use-cases';

/**
 * Éléments du catalogue → messages du contrat (back-office). Champ facultatif absent : null ; noms
 * des auteurs lus dans identity (ADR-029). Montants toujours rendus : le contexte gRPC ne porte pas
 * la permission cleaning.amounts.read (voir application/shared/access.ts).
 */
export type Names = Map<string, string>;

export const money = (amount: number): moneyV1.Money => ({ amount, currency: 'XOF' });
export const maybeMoney = (amount: number | null | undefined) =>
  amount === null || amount === undefined ? undefined : money(amount);
const opt = <T>(value: T | null): T | undefined => value ?? undefined;

const traced = (entry: { updatedAt: Date; updatedBy: string | null }, names: Names) => ({
  updatedAt: entry.updatedAt.toISOString(),
  updatedBy: opt(entry.updatedBy),
  updatedByName: entry.updatedBy ? names.get(entry.updatedBy) : undefined,
});

export function presentCategory(category: PlaceCategory, names: Names): cleaningV1.PlaceCategory {
  return {
    id: category.id,
    code: category.code,
    name: category.name,
    icon: opt(category.icon),
    order: category.order,
    active: category.active,
    visitFee: maybeMoney(category.visitFee),
    ...traced(category, names),
  };
}

export function presentPlaceType(placeType: PlaceTypeView, names: Names): cleaningV1.PlaceType {
  return {
    id: placeType.id,
    code: placeType.code,
    categoryId: placeType.categoryId,
    name: placeType.name,
    icon: opt(placeType.icon),
    photoFileId: opt(placeType.photoFileId),
    description: opt(placeType.description),
    order: placeType.order,
    active: placeType.active,
    freeDescription: placeType.isOther,
    parameters: placeType.parameters.map((link, order) => ({
      parameterId: link.parameterId,
      code: link.code,
      order,
    })),
    areaParameterId: opt(placeType.areaParameterId),
    publiclyVisible: placeType.hiddenReasons.length === 0,
    visibilityReasons: placeType.hiddenReasons,
    ...traced(placeType, names),
  };
}

export function presentParameter(parameter: Parameter, names: Names): cleaningV1.ParameterDefinition {
  return { ...presentPublicParameter(parameter), ...traced(parameter, names) };
}

export function presentPublicParameter(parameter: Parameter): cleaningV1.PublicParameter {
  return {
    id: parameter.id,
    code: parameter.code,
    label: parameter.label,
    kind: parameter.kind,
    unit: opt(parameter.unit),
    min: opt(parameter.min),
    max: opt(parameter.max),
    choices: parameter.choices.map((choice) => ({ ...choice })),
    required: parameter.required,
    help: opt(parameter.help),
    active: parameter.active,
  };
}

export function presentCleaningType(type: CleaningType, names: Names): cleaningV1.CleaningType {
  return {
    id: type.id,
    code: type.code,
    name: type.name,
    description: opt(type.description),
    icon: opt(type.icon),
    requiredSkillCode: opt(type.requiredSkillCode),
    referenceDurationMinutes: type.referenceDurationMinutes,
    checklist: type.checklist.map((item) => ({ ...item })),
    isPack: type.isPack,
    packItemIds: [...type.packItemIds],
    active: type.active,
    ...traced(type, names),
  };
}

export function presentOffer(offer: OfferView, names: Names): cleaningV1.Offer {
  return {
    id: offer.id,
    placeTypeId: offer.placeTypeId,
    cleaningTypeId: offer.cleaningTypeId,
    extraParameters: offer.extraParameters.map((link, order) => ({
      parameterId: link.parameterId,
      code: link.code,
      order,
    })),
    teamRule: offer.teamRule.map((bracket) => ({ ...bracket, toArea: opt(bracket.toArea) })),
    currentTariffVersion: opt(offer.currentTariffVersion),
    draftTariffVersion: opt(offer.draftTariffVersion),
    active: offer.active,
    order: offer.order,
    publiclyVisible: offer.hiddenReasons.length === 0,
    visibilityReasons: offer.hiddenReasons,
    ...traced(offer, names),
  };
}

export function presentTariff(tariff: TariffVersion, names: Names): cleaningV1.Tariff {
  return {
    id: tariff.id,
    offerId: tariff.offerId,
    version: tariff.version,
    status: tariff.status,
    baseParameterCode: opt(tariff.baseParameterCode),
    brackets: tariff.brackets.map((bracket) => ({ ...bracket, amount: money(bracket.amount) })),
    supplements: tariff.supplements.map((supplement) => ({
      parameterCode: supplement.parameterCode,
      choiceCode: opt(supplement.choiceCode),
      mode: supplement.mode,
      amount: maybeMoney(supplement.amount),
      coefficientBps: opt(supplement.coefficientBps),
      includedUnits: supplement.includedUnits,
    })),
    minimum: money(tariff.minimum),
    frequencyCoefficients: tariff.frequencyCoefficients.map((entry) => ({ ...entry })),
    createdAt: tariff.createdAt.toISOString(),
    createdBy: tariff.createdBy,
    createdByName: names.get(tariff.createdBy),
    publishedAt: tariff.publishedAt?.toISOString(),
    publishedBy: opt(tariff.publishedBy),
    publishedByName: tariff.publishedBy ? names.get(tariff.publishedBy) : undefined,
    packDiscountBps: opt(tariff.packDiscountBps),
  };
}

export function presentZone(zone: ZoneView, names: Names): cleaningV1.Zone {
  return {
    id: zone.id,
    communeKey: zone.communeKey,
    name: zone.name,
    coefficientBps: zone.coefficientBps,
    visitFeeSurcharge: maybeMoney(zone.visitFeeSurcharge),
    planningMode: opt(zone.planningMode),
    active: zone.active,
    openRequests: zone.openRequests,
    activePrograms: zone.activePrograms,
    ...traced(zone, names),
  };
}

export const presentSkill = (skill: Skill): cleaningV1.Skill => ({ ...skill });
export const presentHoliday = (holiday: Holiday): cleaningV1.Holiday => ({ ...holiday });
export const presentCommune = (commune: CommuneOption): cleaningV1.CommuneOption => ({
  communeKey: commune.communeKey,
  name: commune.name,
  zoneId: opt(commune.zoneId),
  zoneActive: commune.zoneActive,
});
