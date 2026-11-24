import { type ChecklistItemEntry, type ChoiceEntry, type PlanningMode } from '../../domain/catalog/entries';
import {
  type FrequencyCoefficient,
  type ParameterKind,
  type TariffBracket,
  type TariffStatus,
  type TariffSupplement,
  type TeamRuleBracket,
} from '../../domain/pricing/types';
import { type RequestTimeline } from '../../domain/requests/request-status';
import { type Changes } from '../ports';

/**
 * Ports du catalogue (lot A, partie 4) : éléments tels qu'enregistrés, et dépôts. Rien ne se
 * supprime (R-CA-06) : tout se désactive, sauf un jour férié retiré. Chaque écriture porte ses
 * changements (audit, clé d'idempotence), écrits dans la même transaction ; une unicité violée lève
 * DuplicateKeyError (code déjà pris, clé consommée, écriture concurrente).
 */
export interface Traced {
  updatedAt: Date;
  updatedBy: string | null;
}

export interface PlaceCategory extends Traced {
  id: string;
  code: string;
  name: string;
  icon: string | null;
  order: number;
  active: boolean;
  /** Frais de visite de la catégorie (R-FV-01) ; null : valeur par défaut des réglages. */
  visitFee: number | null;
}

/** Paramètre cité par un lieu ou une offre, dans l'ordre. */
export interface ParameterLink {
  parameterId: string;
  code: string;
}

export interface PlaceType extends Traced {
  id: string;
  code: string;
  categoryId: string;
  name: string;
  icon: string | null;
  photoFileId: string | null;
  description: string | null;
  order: number;
  active: boolean;
  /** Lieu « Autre » (R-CA-05). */
  isOther: boolean;
  parameters: ParameterLink[];
  areaParameterId: string | null;
}

export interface Parameter extends Traced {
  id: string;
  code: string;
  label: string;
  kind: ParameterKind;
  unit: string | null;
  min: number | null;
  max: number | null;
  choices: ChoiceEntry[];
  required: boolean;
  help: string | null;
  active: boolean;
}

export interface Skill {
  id: string;
  code: string;
  name: string;
  active: boolean;
}

export interface CleaningType extends Traced {
  id: string;
  code: string;
  name: string;
  description: string | null;
  icon: string | null;
  requiredSkillCode: string | null;
  referenceDurationMinutes: number;
  checklist: ChecklistItemEntry[];
  isPack: boolean;
  packItemIds: string[];
  active: boolean;
}

export interface Offer extends Traced {
  id: string;
  placeTypeId: string;
  cleaningTypeId: string;
  extraParameters: ParameterLink[];
  teamRule: TeamRuleBracket[];
  order: number;
  active: boolean;
  createdAt: Date;
}

/** Version de tarif enregistrée (R-CA-07) ; les suppléments citent aussi l'identifiant du paramètre. */
export interface TariffVersion {
  id: string;
  offerId: string;
  version: number;
  status: TariffStatus;
  baseParameterId: string | null;
  baseParameterCode: string | null;
  brackets: TariffBracket[];
  supplements: (TariffSupplement & { parameterId: string })[];
  minimum: number;
  frequencyCoefficients: FrequencyCoefficient[];
  packDiscountBps: number | null;
  createdAt: Date;
  createdBy: string;
  publishedAt: Date | null;
  publishedBy: string | null;
}

export interface Zone extends Traced {
  id: string;
  communeKey: string;
  name: string;
  coefficientBps: number;
  visitFeeSurcharge: number | null;
  planningMode: PlanningMode | null;
  active: boolean;
}

export interface Holiday {
  id: string;
  /** AAAA-MM-JJ, heure de Porto-Novo. */
  date: string;
  name: string;
}

/** Réglages lus par le catalogue (partie 16.1). */
export interface CatalogSettings {
  defaultVisitFee: number;
  programMaxMonths: number;
  programMaxSessions: number;
}

export type SaveMode = 'create' | 'update';

export interface PlaceCatalogRepository {
  listCategories(): Promise<PlaceCategory[]>;
  getCategory(id: string): Promise<PlaceCategory | null>;
  saveCategory(category: PlaceCategory, mode: SaveMode, changes: Changes): Promise<void>;
  listPlaceTypes(): Promise<PlaceType[]>;
  getPlaceType(id: string): Promise<PlaceType | null>;
  savePlaceType(placeType: PlaceType, mode: SaveMode, changes: Changes): Promise<void>;
}

export interface ParameterRepository {
  listParameters(): Promise<Parameter[]>;
  getParameter(id: string): Promise<Parameter | null>;
  saveParameter(parameter: Parameter, mode: SaveMode, changes: Changes): Promise<void>;
  /** Tarifs publiés (base ou supplément) et lieux actifs qui utilisent le paramètre (R-CA-11). */
  usageOf(parameterId: string): Promise<{ offerIds: string[]; placeTypeIds: string[] }>;
}

export interface CleaningTypeRepository {
  listCleaningTypes(): Promise<CleaningType[]>;
  getCleaningType(id: string): Promise<CleaningType | null>;
  saveCleaningType(type: CleaningType, mode: SaveMode, changes: Changes): Promise<void>;
  listSkills(): Promise<Skill[]>;
  getSkill(id: string): Promise<Skill | null>;
  saveSkill(skill: Skill, mode: SaveMode, at: Date, changes: Changes): Promise<void>;
}

export interface OfferRepository {
  listOffers(filter?: { placeTypeId?: string; cleaningTypeId?: string }): Promise<Offer[]>;
  getOffer(id: string): Promise<Offer | null>;
  saveOffer(offer: Offer, mode: SaveMode, changes: Changes): Promise<void>;
  /** Versions de tarif des offres, version décroissante. */
  listTariffs(offerIds: readonly string[]): Promise<TariffVersion[]>;
  getTariffsByIds(ids: readonly string[]): Promise<TariffVersion[]>;
  /** Nouveau brouillon (version suivante) ou brouillon remplacé ; DuplicateKeyError('concurrent'). */
  saveDraft(tariff: TariffVersion, mode: SaveMode, changes: Changes): Promise<void>;
  /** Publie le brouillon et archive la version publiée précédente, dans une transaction. */
  publish(input: {
    tariffId: string;
    previousPublishedId: string | null;
    at: Date;
    by: string;
    changes: Changes;
  }): Promise<void>;
}

/** Activité d'une commune desservie (confirmation avant désactivation de sa zone). */
export interface ZoneActivity {
  requests: RequestTimeline[];
  activePrograms: number;
}

export interface ZoneRepository {
  listZones(): Promise<Zone[]>;
  getZone(id: string): Promise<Zone | null>;
  findByCommune(communeKey: string): Promise<Zone | null>;
  saveZone(zone: Zone, mode: SaveMode, changes: Changes): Promise<void>;
  activityOf(communeKeys: readonly string[]): Promise<Map<string, ZoneActivity>>;
}

export interface HolidayRepository {
  /** Jours fériés retenus, par date ; `year` : d'une seule année. */
  listHolidays(year?: number): Promise<Holiday[]>;
  getHoliday(id: string): Promise<Holiday | null>;
  /** Ajout ; un jour retiré à la même date est repris (DuplicateKeyError('code') si actif). */
  addHoliday(holiday: Holiday, at: Date, by: string, changes: Changes): Promise<Holiday>;
  removeHoliday(id: string, at: Date, by: string, changes: Changes): Promise<void>;
}

export interface CatalogSettingsReader {
  catalogSettings(): Promise<CatalogSettings>;
}

/** Commune du référentiel de geo (R-ZN-03). */
export interface Commune {
  key: string;
  name: string;
}

/**
 * Référentiel des communes de geo (ListCommunes, R-ZN-03), mis en cache court. geo indisponible :
 * AppError CLEANING_GEO_UNAVAILABLE, jamais d'enregistrement sans contrôle.
 */
export interface CommuneDirectory {
  listCommunes(): Promise<Commune[]>;
}
