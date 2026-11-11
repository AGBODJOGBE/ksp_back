import { type ServiceDefinition } from '../../domain/catalog';
import { aggregateEstimates, type EstimateStatus } from '../../domain/estimate';
import {
  type PlaceCatalog,
  type PlaceType,
  type PlaceTypeHealth,
  placeTypeHealth,
  placeTypeProblems,
  placeTypesOffering,
  publicPlaceCatalog,
  serviceCodesChange,
  sortPlaceTypes,
  unplacedServiceCodes,
} from '../../domain/place-type';
import { calculatePrice, type PriceCalculation } from '../../domain/simulator';
import { isCovered } from '../../domain/zone';
import { calculationNotice } from '../catalog/catalog.use-cases';
import { type CleaningDeps } from '../deps';
import { ADMINISTRATION, GATEWAY_CALLERS, requireCaller, requireStaff } from '../shared/access';
import { CleaningErrors } from '../shared/errors';
import { optionalText, requiredText } from '../shared/validation';
import { activePlaceType, type PlaceItemInput, resolvePlaceItems } from './place-items';

/** Parcours par lieu (ADR-034) : catalogue public, estimation, types de lieu au back-office. */

export const PARTIAL_ESTIMATE_NOTICE =
  "Au moins une prestation n'a pas encore de prix publié : demandez un devis, KSP vous répondra.";

/** Catalogue public : lieux actifs triés, prestations actives référencées avec leur formulaire. */
export class GetPlaceCatalogUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(): Promise<PlaceCatalog> {
    requireCaller(GATEWAY_CALLERS);
    const [placeTypes, services] = await Promise.all([
      this.deps.catalog.listPlaceTypes(),
      this.deps.catalog.listServices(),
    ]);
    return publicPlaceCatalog(placeTypes, services);
  }
}

export interface EstimateInput {
  placeType: string;
  /** Facultative : vide ou absente, coefficient de commune neutre. */
  commune?: string | null | undefined;
  items: PlaceItemInput[];
}

export interface EstimateItemResult {
  service: ServiceDefinition;
  calculation: PriceCalculation;
  notice: string;
}

export interface EstimateResult {
  placeType: string;
  commune: string | null;
  communeApplied: boolean;
  covered: boolean;
  status: EstimateStatus;
  total: number | null;
  notice: string;
  items: EstimateItemResult[];
}

/** Estimation de plusieurs prestations d'un lieu : simulateur de l'ADR-033 pour chacune, puis la somme. */
export class EstimateUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: EstimateInput): Promise<EstimateResult> {
    requireCaller(GATEWAY_CALLERS);
    const commune = optionalText('commune', input.commune ?? undefined, 100);
    const placeType = await activePlaceType(this.deps, input.placeType);
    const resolved = await resolvePlaceItems(this.deps, placeType, input.items);
    const communeApplied = commune !== null;
    const items = resolved.map(({ service, form }) => {
      const calculation = calculatePrice(service, { ...form, commune });
      return { service, calculation, notice: calculationNotice(calculation, communeApplied) };
    });
    const { status, total } = aggregateEstimates(items.map((item) => item.calculation));
    return {
      placeType: placeType.code,
      commune,
      communeApplied,
      covered: commune !== null && isCovered(await this.deps.catalog.listZones(), commune),
      status,
      total,
      notice:
        status === 'priced'
          ? calculationNotice(items[0]!.calculation, communeApplied)
          : PARTIAL_ESTIMATE_NOTICE,
      items,
    };
  }
}

/** Type de lieu vu du back-office, avec la cohérence de ses prestations (ADR-034). */
export interface PlaceTypeView {
  placeType: PlaceType;
  health: PlaceTypeHealth;
}

/** Types de lieu, actifs et désactivés (admin), par ordre d'affichage, avec leur cohérence. */
export class ListPlaceTypesUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(): Promise<PlaceTypeView[]> {
    requireStaff(ADMINISTRATION);
    const [placeTypes, services] = await Promise.all([
      this.deps.catalog.listPlaceTypes(),
      this.deps.catalog.listServices(),
    ]);
    return sortPlaceTypes(placeTypes).map((placeType) => ({
      placeType,
      health: placeTypeHealth(placeType, services),
    }));
  }
}

export interface PlaceTypeInput {
  code: string;
  label: string;
  description?: string | null | undefined;
  icon: string;
  displayOrder: number;
  active: boolean;
  serviceCodes: string[];
}

/**
 * Crée ou modifie un type de lieu. Une prestation inconnue est refusée ; une prestation inactive
 * est acceptée (masquée côté public tant qu'elle l'est). Pas de suppression : `active: false`.
 * Le journal garde la différence des prestations proposées.
 */
export class SavePlaceTypeUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: PlaceTypeInput): Promise<PlaceTypeView> {
    const staff = requireStaff(ADMINISTRATION);
    const draft = {
      code: input.code,
      label: requiredText('label', input.label, 100),
      description: optionalText('description', input.description ?? undefined, 500) ?? '',
      icon: requiredText('icon', input.icon, 50),
      displayOrder: input.displayOrder,
      active: input.active,
      serviceCodes: [...input.serviceCodes],
    };
    const problems = placeTypeProblems(draft);
    if (problems.length) throw CleaningErrors.invalid(problems[0]!);
    const [services, placeTypes] = await Promise.all([
      this.deps.catalog.listServices(),
      this.deps.catalog.listPlaceTypes(),
    ]);
    const known = new Set(services.map((service) => service.code));
    draft.serviceCodes.forEach((code, index) => {
      if (!known.has(code)) {
        throw CleaningErrors.invalid(`serviceCodes[${index}]`, `Prestation inconnue : ${code}.`);
      }
    });
    const previous = placeTypes.find((placeType) => placeType.code === draft.code);
    const now = this.deps.clock.now();
    const saved = await this.deps.catalog.savePlaceType(
      { ...draft, updatedBy: staff.userId, updatedAt: now },
      {
        events: [],
        audit: [
          {
            actorId: staff.userId,
            action: 'place_type.saved',
            entityType: 'place_type',
            entityId: draft.code,
            at: now,
            details: {
              created: !previous,
              active: draft.active,
              serviceCodes: draft.serviceCodes,
              ...serviceCodesChange(previous?.serviceCodes ?? [], draft.serviceCodes),
            },
          },
        ],
      },
    );
    return { placeType: saved, health: placeTypeHealth(saved, services) };
  }
}

/** Cohérence du catalogue au back-office (ADR-034) : prestations et types de lieu. */
export class CatalogConsistencyUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  /** Types de lieu actifs qui proposent encore une prestation (désactivée, par exemple). */
  async placeTypesOffering(serviceCode: string): Promise<PlaceType[]> {
    requireStaff(ADMINISTRATION);
    return placeTypesOffering(await this.deps.catalog.listPlaceTypes(), serviceCode);
  }

  /** Prestations actives proposées par aucun type de lieu actif. */
  async unplacedServices(services: readonly ServiceDefinition[]): Promise<string[]> {
    requireStaff(ADMINISTRATION);
    return unplacedServiceCodes(services, await this.deps.catalog.listPlaceTypes());
  }
}
