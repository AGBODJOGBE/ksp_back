import { assertOrganizationRight } from '../../domain/requests/organization-access';
import { type ParameterValue } from '../../domain/pricing/types';
import { type CleaningDeps } from '../deps';
import { type GeoPoint } from '../ports';
import { cleaningErrors } from '../shared/errors';
import { runIdempotent } from '../shared/idempotency';
import { requireUuid, text } from '../shared/input';
import { pageOf, parsePage, parseSort } from '../shared/paging';
import { ConcurrentUpdateError } from '../agents/agent.ports';
import { caseErrors, decide } from './case-errors';
import { type Customer, currentCustomer, ownedBy } from './customer';
import {
  decryptLocation,
  encryptLocation,
  parseAccuracy,
  parsePoint,
  type PlainLocation,
  requireCommune,
} from './locations';
import { type PlaceRecord, type ResolvedCommune } from './requests.ports';

/**
 * « Mes lieux » (UC-NT-03, partie 3, R-DM-01, R-ZN-01) et vérification d'une position. La commune
 * est celle dont le contour contient la position (geo) ; l'adresse lisible n'est demandée que pour
 * une commune desservie (RV-39, RV-47) et n'est qu'une information. Lieux du contexte actif.
 */
export interface PointLocationView {
  commune: { key: string; name: string } | null;
  served: boolean;
  readableAddress: string | null;
}

export interface PlaceView {
  place: PlaceRecord;
  placeTypeName: string;
  communeName: string;
  served: boolean;
  location: PlainLocation | null;
}

export interface PlaceInput {
  name?: string | undefined;
  placeTypeId?: string | undefined;
  latitude?: number | undefined;
  longitude?: number | undefined;
  accuracyMeters?: number | undefined;
  landmark?: string | undefined;
  address?: string | undefined;
  declaredValues?: Record<string, ParameterValue> | undefined;
}

const MAX_NAME_LENGTH = 100;

function placeName(value: string | undefined): string {
  const name = value?.trim() ?? '';
  if (!name) throw cleaningErrors.invalid('name', 'required');
  if (name.length > MAX_NAME_LENGTH) throw cleaningErrors.invalid('name', 'out_of_range');
  return name;
}

function declared(values: Record<string, ParameterValue> | undefined): Record<string, ParameterValue> {
  const result: Record<string, ParameterValue> = {};
  for (const [code, value] of Object.entries(values ?? {})) {
    const ok = typeof value === 'boolean' || typeof value === 'string' || Number.isSafeInteger(value);
    if (!ok) throw cleaningErrors.invalid(`declaredValues.${code}`, 'invalid_type');
    result[code] = value;
  }
  return result;
}

/** Organisation : « org_member » au moins pour écrire (R-CP-03). */
export function requireActor(customer: Customer): void {
  decide(() => assertOrganizationRight(customer.role, 'submit_request'));
}

export class PlacesUseCases {
  constructor(private readonly deps: CleaningDeps) {}

  /** Commune par contour, desserte, puis adresse lisible si desservie (RV-39). Rien n'est écrit. */
  async locate(point: GeoPoint): Promise<PointLocationView & { resolved: ResolvedCommune }> {
    const resolved = await this.deps.communeResolver.resolve(point);
    if (!resolved.commune) return { commune: null, served: false, readableAddress: null, resolved };
    const zone = await this.deps.zones.findByCommune(resolved.commune.key);
    const served = zone?.active ?? false;
    const readableAddress = served
      ? ((await this.deps.geocoder.reverse(point))?.displayAddress ?? null)
      : null;
    return { commune: resolved.commune, served, readableAddress, resolved };
  }

  /** POST /places/locate (R-ZN-01). */
  async locatePoint(input: { latitude: number; longitude: number }): Promise<PointLocationView> {
    currentCustomer();
    const point = parsePoint(input.latitude, input.longitude) as GeoPoint;
    const { commune, served, readableAddress } = await this.locate(point);
    return { commune, served, readableAddress };
  }

  async list(input: {
    archived?: boolean | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
    sort?: string | undefined;
  }) {
    const customer = currentCustomer();
    const page = parsePage(input);
    const sort = parseSort(input.sort, ['-createdAt', 'name']);
    const places = await this.deps.clientPlaces.listPlaces(customer.owner, {
      archived: input.archived ?? false,
      sort,
    });
    const slice = pageOf(places, page);
    return { ...slice, items: await this.views(slice.items) };
  }

  async get(placeId: string): Promise<PlaceView> {
    const customer = currentCustomer();
    return (await this.views([await this.owned(customer, placeId)]))[0]!;
  }

  async create(input: PlaceInput & { idempotencyKey: string }): Promise<PlaceView> {
    const customer = currentCustomer();
    requireActor(customer);
    const name = placeName(input.name);
    const placeTypeId = requireUuid(input.placeTypeId, 'placeTypeId');
    const point = parsePoint(input.latitude, input.longitude);
    if (!point) throw cleaningErrors.invalid('latitude', 'required');
    const accuracyM = parseAccuracy(input.accuracyMeters);
    const landmark = text(input.landmark, 'landmark');
    const address = text(input.address, 'address');
    const values = declared(input.declaredValues);
    const body = { name, placeTypeId, point, accuracyM, landmark, address, values, owner: customer.owner };
    const now = this.deps.clock.now();
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: customer.userId,
      operation: 'place.create',
      key: input.idempotencyKey,
      body,
      at: now,
      replay: async (response) => this.get(String(response.placeId)),
      run: async (stub) => {
        const placeType = await this.deps.places.getPlaceType(placeTypeId);
        if (!placeType?.active) throw cleaningErrors.invalid('placeTypeId', 'unknown_choice');
        const located = await this.servedLocation(point);
        const id = this.deps.ids.next();
        const place: PlaceRecord = {
          id,
          owner: customer.owner,
          placeTypeId,
          name,
          declaredValues: values,
          ...encryptLocation(
            this.deps.cipher,
            'place',
            id,
            { ...point, accuracyM, landmark, address, readableAddress: located.readableAddress },
            located.resolved,
          ),
          locationCorrectedAt: null,
          locationCorrectedBy: null,
          archivedAt: null,
          createdBy: customer.userId,
          createdAt: now,
          updatedAt: now,
          version: 0,
        };
        await this.deps.clientPlaces.insertPlace(place, {
          events: [],
          audit: [],
          idempotency: stub({ placeId: id }),
        });
        return (await this.views([place]))[0]!;
      },
    });
  }

  /** PATCH : champs absents inchangés ; une nouvelle position remet l'effacement à null (RV-40). */
  async update(input: PlaceInput & { placeId: string }): Promise<PlaceView> {
    const customer = currentCustomer();
    requireActor(customer);
    const current = await this.owned(customer, input.placeId);
    const point = parsePoint(input.latitude, input.longitude);
    const now = this.deps.clock.now();
    const plain = decryptLocation(this.deps.cipher, 'place', current.id, current);
    let next: PlaceRecord = {
      ...current,
      name: input.name !== undefined ? placeName(input.name) : current.name,
      declaredValues:
        input.declaredValues && Object.keys(input.declaredValues).length
          ? declared(input.declaredValues)
          : current.declaredValues,
      updatedAt: now,
    };
    const landmark =
      input.landmark !== undefined ? text(input.landmark, 'landmark') : (plain?.landmark ?? null);
    const address = input.address !== undefined ? text(input.address, 'address') : (plain?.address ?? null);
    if (point) {
      const located = await this.servedLocation(point);
      const location = {
        ...point,
        accuracyM: parseAccuracy(input.accuracyMeters),
        landmark,
        address,
        readableAddress: located.readableAddress,
      };
      next = {
        ...next,
        ...encryptLocation(this.deps.cipher, 'place', current.id, location, located.resolved),
      };
    } else if (plain && (input.landmark !== undefined || input.address !== undefined)) {
      const resolved = {
        commune: { key: current.communeKey, name: '' },
        boundariesVersion: current.communeBoundariesVersion,
      };
      next = {
        ...next,
        ...encryptLocation(this.deps.cipher, 'place', current.id, { ...plain, landmark, address }, resolved),
      };
    }
    await this.write(next, current.version);
    return (await this.views([next]))[0]!;
  }

  /** Rejouable sans effet (R-CA-06) : les dossiers qui l'utilisent le gardent. */
  async archive(placeId: string): Promise<PlaceView> {
    const customer = currentCustomer();
    requireActor(customer);
    const current = await this.owned(customer, placeId);
    if (current.archivedAt) return (await this.views([current]))[0]!;
    const now = this.deps.clock.now();
    const next = { ...current, archivedAt: now, updatedAt: now };
    await this.write(next, current.version);
    return (await this.views([next]))[0]!;
  }

  private async write(place: PlaceRecord, expectedVersion: number): Promise<void> {
    try {
      await this.deps.clientPlaces.updatePlace(place, expectedVersion, { events: [], audit: [] });
    } catch (error) {
      if (error instanceof ConcurrentUpdateError) throw cleaningErrors.concurrentUpdate();
      throw error;
    }
  }

  /** Position desservie, sinon CLEANING_ZONE_NOT_COVERED (R-DM-01). */
  private async servedLocation(point: GeoPoint) {
    const located = await this.locate(point);
    const resolved = requireCommune(located.resolved);
    if (!located.served) throw caseErrors.zoneNotCovered('commune_not_served', resolved.commune);
    return { resolved, readableAddress: located.readableAddress };
  }

  private async owned(customer: Customer, placeId: string): Promise<PlaceRecord> {
    const id = requireUuid(placeId, 'placeId');
    const place = await this.deps.clientPlaces.findPlace(id);
    if (!place || !ownedBy(customer, place.owner)) throw caseErrors.placeNotFound();
    return place;
  }

  /** Noms lus sans filtre « actif » (RV-46) ; référentiel des communes indisponible : la clé. */
  async views(places: readonly PlaceRecord[]): Promise<PlaceView[]> {
    const [types, communes] = await Promise.all([
      this.deps.places.listPlaceTypes(),
      this.deps.communes.listCommunes().catch(() => []),
    ]);
    const zones = new Map<string, boolean>();
    for (const key of new Set(places.map((place) => place.communeKey))) {
      zones.set(key, (await this.deps.zones.findByCommune(key))?.active ?? false);
    }
    return places.map((place) => ({
      place,
      placeTypeName: types.find((type) => type.id === place.placeTypeId)?.name ?? '',
      communeName: communes.find((commune) => commune.key === place.communeKey)?.name ?? place.communeKey,
      served: zones.get(place.communeKey) ?? false,
      location: decryptLocation(this.deps.cipher, 'place', place.id, place),
    }));
  }
}
