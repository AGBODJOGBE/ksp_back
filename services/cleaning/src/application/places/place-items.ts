import { type Answers, type FormAnswers, type OptionSelection } from '../../domain/answers';
import { isCode, type ServiceDefinition } from '../../domain/catalog';
import { MAX_GROUP_ITEMS } from '../../domain/estimate';
import { offersService, type PlaceType } from '../../domain/place-type';
import { resolveNewFormat } from '../catalog/pricing-input';
import { type CleaningDeps } from '../deps';
import { CleaningErrors } from '../shared/errors';

/**
 * Prestations choisies pour un lieu (ADR-034), communes à l'estimation et au groupe de demandes :
 * 1 à 10 prestations distinctes, actives et proposées par le lieu, réponses au nouveau format de
 * l'ADR-033 (le champ en défaut est préfixé par « items[i]. »).
 */
export interface PlaceItemInput {
  serviceCode: string;
  answers?: Answers | undefined;
  optionSelections?: OptionSelection[] | undefined;
  frequency?: string | undefined;
}

export interface ResolvedPlaceItem {
  service: ServiceDefinition;
  form: FormAnswers;
}

/** Type de lieu actif, sinon introuvable (un lieu désactivé n'existe plus pour le public). */
export async function activePlaceType(deps: CleaningDeps, code: string): Promise<PlaceType> {
  const placeType = isCode(code)
    ? (await deps.catalog.listPlaceTypes()).find((candidate) => candidate.code === code)
    : undefined;
  if (!placeType || !placeType.active) throw CleaningErrors.placeTypeNotFound();
  return placeType;
}

export async function resolvePlaceItems(
  deps: CleaningDeps,
  placeType: PlaceType,
  items: readonly PlaceItemInput[],
): Promise<ResolvedPlaceItem[]> {
  if (items.length < 1 || items.length > MAX_GROUP_ITEMS) {
    throw CleaningErrors.invalid('items', `Choisissez de 1 à ${MAX_GROUP_ITEMS} prestations.`);
  }
  const services = await deps.catalog.listServices();
  const seen = new Set<string>();
  return items.map((item, index) => {
    const field = `items[${index}].serviceCode`;
    if (!isCode(item.serviceCode)) throw CleaningErrors.invalid(field);
    if (seen.has(item.serviceCode)) {
      throw CleaningErrors.invalid(field, 'Cette prestation est déjà dans la liste.');
    }
    seen.add(item.serviceCode);
    const service = services.find((candidate) => candidate.code === item.serviceCode && candidate.active);
    // Une prestation inactive est masquée sous le lieu : elle n'est pas proposée.
    if (!service || !offersService(placeType, service.code)) {
      throw CleaningErrors.serviceNotOffered(field, placeType.code, item.serviceCode);
    }
    const { value } = resolveNewFormat(service, item, `items[${index}].`);
    return { service, form: value };
  });
}
