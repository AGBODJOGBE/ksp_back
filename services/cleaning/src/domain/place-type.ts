import { isCode, type ServiceDefinition } from './catalog';

/**
 * Type de lieu du parcours client (ADR-034) : Maison, Villa, Appartement, Bureau, Chantier…, défini
 * au back-office avec la liste ordonnée des prestations qu'il propose. Une même prestation peut
 * servir à plusieurs lieux. Rien n'est codé en dur : pas de suppression, un lieu se désactive.
 */
export interface PlaceType {
  code: string;
  label: string;
  description: string;
  /** Nom d'icône libre (« house », « office »…), interprété par le front. */
  icon: string;
  /** Ordre d'affichage croissant (le code départage). */
  displayOrder: number;
  active: boolean;
  /** Codes des prestations proposées, dans l'ordre d'affichage. */
  serviceCodes: string[];
  updatedBy: string | null;
  updatedAt: Date | null;
}

export type PlaceTypeDraft = Omit<PlaceType, 'updatedBy' | 'updatedAt'>;

export const MAX_PLACE_TYPE_SERVICES = 30;
export const MAX_DISPLAY_ORDER = 10_000;

const hasText = (value: string, max: number) => value.trim().length > 0 && value.length <= max;

/** Contrôle d'un type de lieu avant enregistrement : chemins des propriétés en défaut. */
export function placeTypeProblems(draft: PlaceTypeDraft): string[] {
  const problems: string[] = [];
  if (!isCode(draft.code)) problems.push('code');
  if (!hasText(draft.label, 100)) problems.push('label');
  if (draft.description.length > 500) problems.push('description');
  if (!hasText(draft.icon, 50)) problems.push('icon');
  if (
    !Number.isInteger(draft.displayOrder) ||
    draft.displayOrder < 0 ||
    draft.displayOrder > MAX_DISPLAY_ORDER
  )
    problems.push('displayOrder');
  if (draft.serviceCodes.length > MAX_PLACE_TYPE_SERVICES) problems.push('serviceCodes');
  const seen = new Set<string>();
  draft.serviceCodes.forEach((code, index) => {
    if (!isCode(code) || seen.has(code)) problems.push(`serviceCodes[${index}]`);
    seen.add(code);
  });
  return problems;
}

/** Le lieu propose-t-il cette prestation ? */
export function offersService(placeType: Pick<PlaceType, 'serviceCodes'>, serviceCode: string): boolean {
  return placeType.serviceCodes.includes(serviceCode);
}

const byDisplayOrder = (a: PlaceType, b: PlaceType) =>
  a.displayOrder - b.displayOrder || a.code.localeCompare(b.code);

export interface PlaceCatalog {
  /** Types de lieu actifs, avec seulement leurs prestations actives ; un lieu sans prestation active est masqué. */
  placeTypes: PlaceType[];
  /** Prestations actives référencées par ces lieux, dans l'ordre de première apparition. */
  services: ServiceDefinition[];
}

/**
 * Catalogue public du parcours par lieu : lieux actifs triés, prestations actives seulement (une
 * prestation inactive ou inconnue n'apparaît pas sous un lieu).
 */
export function publicPlaceCatalog(placeTypes: PlaceType[], services: ServiceDefinition[]): PlaceCatalog {
  const active = new Map(
    services.filter((service) => service.active).map((service) => [service.code, service]),
  );
  const visible = placeTypes
    .filter((placeType) => placeType.active)
    .map((placeType) => ({
      ...placeType,
      serviceCodes: placeType.serviceCodes.filter((code) => active.has(code)),
    }))
    .filter((placeType) => placeType.serviceCodes.length > 0)
    .sort(byDisplayOrder);
  const codes = [...new Set(visible.flatMap((placeType) => placeType.serviceCodes))];
  return { placeTypes: visible, services: codes.map((code) => active.get(code)!) };
}

/** Tous les types de lieu (back-office), triés comme au public. */
export function sortPlaceTypes(placeTypes: PlaceType[]): PlaceType[] {
  return [...placeTypes].sort(byDisplayOrder);
}

// ---------------------------------------------------------------------------
// Cohérence du catalogue, vue du back-office
// ---------------------------------------------------------------------------

/** Raison d'un lieu absent du parcours public. */
export type VisibilityReason = 'inactive' | 'no_active_service';

export interface PlaceTypeHealth {
  /** Prestations proposées qui n'existent pas (ou plus) dans le catalogue. */
  unknownServiceCodes: string[];
  /** Prestations proposées mais désactivées : masquées sous ce lieu. */
  inactiveServiceCodes: string[];
  publiclyVisible: boolean;
  visibilityReason: VisibilityReason | null;
}

export function placeTypeHealth(
  placeType: Pick<PlaceType, 'active' | 'serviceCodes'>,
  services: readonly Pick<ServiceDefinition, 'code' | 'active'>[],
): PlaceTypeHealth {
  const byCode = new Map(services.map((service) => [service.code, service]));
  const unknownServiceCodes = placeType.serviceCodes.filter((code) => !byCode.has(code));
  const inactiveServiceCodes = placeType.serviceCodes.filter((code) => byCode.get(code)?.active === false);
  const hasActive = placeType.serviceCodes.some((code) => byCode.get(code)?.active === true);
  const visibilityReason: VisibilityReason | null = !placeType.active
    ? 'inactive'
    : hasActive
      ? null
      : 'no_active_service';
  return {
    unknownServiceCodes,
    inactiveServiceCodes,
    publiclyVisible: visibilityReason === null,
    visibilityReason,
  };
}

/** Types de lieu actifs qui proposent encore cette prestation. */
export function placeTypesOffering(placeTypes: readonly PlaceType[], serviceCode: string): PlaceType[] {
  return sortPlaceTypes(
    placeTypes.filter((placeType) => placeType.active && offersService(placeType, serviceCode)),
  );
}

/** Prestations actives proposées par aucun type de lieu actif : invisibles dans le parcours par lieu. */
export function unplacedServiceCodes(
  services: readonly Pick<ServiceDefinition, 'code' | 'active'>[],
  placeTypes: readonly PlaceType[],
): string[] {
  const offered = new Set(
    placeTypes.filter((placeType) => placeType.active).flatMap((placeType) => placeType.serviceCodes),
  );
  return services
    .filter((service) => service.active && !offered.has(service.code))
    .map((service) => service.code)
    .sort();
}

/** Différence des prestations proposées, pour le journal d'audit. */
export function serviceCodesChange(
  before: readonly string[],
  after: readonly string[],
): { added: string[]; removed: string[] } {
  return {
    added: after.filter((code) => !before.includes(code)),
    removed: before.filter((code) => !after.includes(code)),
  };
}
