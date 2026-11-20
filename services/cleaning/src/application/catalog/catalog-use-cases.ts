import { type CleaningDeps } from '../deps';
import {
  PreviewScheduleUseCase,
  SimulateUseCase,
  SimulateWithDraftsUseCase,
} from '../simulation/simulate.use-cases';
import { CleaningTypesUseCases } from './cleaning-types.use-cases';
import { OffersUseCases } from './offers.use-cases';
import { ParametersUseCases } from './parameters.use-cases';
import { PlaceCategoriesUseCases, PlaceTypesUseCases } from './places.use-cases';
import { PublicCatalogUseCases } from './public-catalog.use-cases';
import { HolidaysUseCases, SkillsUseCases } from './skills-holidays.use-cases';
import { TariffsUseCases } from './tariffs.use-cases';
import { ZonesUseCases } from './zones.use-cases';

/** Jeton d'injection des cas d'usage du lot A (racine de composition : app.module.ts). */
export const CATALOG_USE_CASES = Symbol('CATALOG_USE_CASES');

/** Cas d'usage du catalogue et du simulateur (UC-NT-01, 02, 25 à 29), branchés sur les mêmes dépendances. */
export function catalogUseCases(deps: CleaningDeps) {
  return {
    publicCatalog: new PublicCatalogUseCases(deps),
    simulate: new SimulateUseCase(deps),
    simulateWithDrafts: new SimulateWithDraftsUseCase(deps),
    previewSchedule: new PreviewScheduleUseCase(deps),
    categories: new PlaceCategoriesUseCases(deps),
    placeTypes: new PlaceTypesUseCases(deps),
    cleaningTypes: new CleaningTypesUseCases(deps),
    parameters: new ParametersUseCases(deps),
    offers: new OffersUseCases(deps),
    tariffs: new TariffsUseCases(deps),
    skills: new SkillsUseCases(deps),
    holidays: new HolidaysUseCases(deps),
    zones: new ZonesUseCases(deps),
    /** Noms affichés des auteurs (ADR-029), lus dans identity au moment de la réponse. */
    userNames: (ids: readonly (string | null)[]) =>
      deps.people.userNames([...new Set(ids.filter((id): id is string => !!id))]),
  };
}

export type CatalogUseCases = ReturnType<typeof catalogUseCases>;
