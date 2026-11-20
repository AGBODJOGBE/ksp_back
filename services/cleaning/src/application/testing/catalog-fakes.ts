import { runWithContext } from '@ksp/platform';
import {
  type CatalogSettings,
  type CleaningType,
  type Commune,
  type Holiday,
  type Offer,
  type Parameter,
  type PlaceCategory,
  type PlaceType,
  type SaveMode,
  type Skill,
  type TariffVersion,
  type Zone,
  type ZoneActivity,
} from '../catalog/catalog.ports';
import { type CleaningDeps } from '../deps';
import { type AuditEntry, type Changes, DuplicateKeyError, type IdempotencyRecord } from '../ports';
import { CleaningErrors } from '../shared/errors';

/**
 * Faux du catalogue pour les tests des cas d'usage : tout en mémoire, mêmes unicités que la base
 * (codes, offre par lieu et type, commune d'une zone, date d'un jour férié, clé d'idempotence).
 */
export const NOW = new Date('2026-11-20T10:00:00.000Z');
export const STAFF_ID = '0192f1c4-0000-7000-8000-00000000ad01';

const clone = <T>(value: T): T => structuredClone(value);

export class CatalogMemory {
  categories = new Map<string, PlaceCategory>();
  placeTypes = new Map<string, PlaceType>();
  parameters = new Map<string, Parameter>();
  cleaningTypes = new Map<string, CleaningType>();
  skills = new Map<string, Skill>();
  offers = new Map<string, Offer>();
  tariffs = new Map<string, TariffVersion>();
  zones = new Map<string, Zone>();
  holidays = new Map<string, Holiday & { active: boolean }>();
  activity = new Map<string, ZoneActivity>();
  settings: CatalogSettings = { defaultVisitFee: 5000, programMaxMonths: 24, programMaxSessions: 400 };
  communes: Commune[] | null = [
    { key: 'cotonou', name: 'Cotonou' },
    { key: 'porto-novo', name: 'Porto-Novo' },
    { key: 'abomey-calavi', name: 'Abomey-Calavi' },
  ];
  audit: AuditEntry[] = [];
  records = new Map<string, IdempotencyRecord>();
  writes = 0;
  private seq = 0;

  nextId = () => `0192f1c4-0000-7000-8000-${String(++this.seq).padStart(12, '0')}`;

  /** Écrit les changements comme writeChanges : clé d'idempotence d'abord, puis l'audit. */
  private commit(changes: Changes, apply: () => void): void {
    const record = changes.idempotency;
    if (record) {
      const key = `${record.actorId}|${record.operation}|${record.key}`;
      if (this.records.has(key)) throw new DuplicateKeyError('idempotency');
      this.records.set(key, clone(record));
    }
    apply();
    this.audit.push(...changes.audit);
    this.writes += 1;
  }

  private save<T extends { id: string }>(
    map: Map<string, T>,
    entity: T,
    mode: SaveMode,
    changes: Changes,
    unique: (other: T) => boolean,
  ): void {
    if (mode === 'create' && [...map.values()].some(unique)) throw new DuplicateKeyError('code');
    this.commit(changes, () => map.set(entity.id, clone(entity)));
  }

  deps(): CleaningDeps {
    const get = <T>(map: Map<string, T>, id: string) => (map.has(id) ? clone(map.get(id) as T) : null);
    const all = <T>(map: Map<string, T>) => [...map.values()].map(clone);
    return {
      people: {
        userNames: async (ids) => new Map(ids.map((id) => [id, `Nom ${id.slice(-4)}`])),
        organizationNames: async () => new Map(),
      },
      wallet: {} as CleaningDeps['wallet'],
      photos: {} as CleaningDeps['photos'],
      planning: {} as CleaningDeps['planning'],
      travel: {} as CleaningDeps['travel'],
      cipher: {} as CleaningDeps['cipher'],
      geocoder: { reverse: async () => null },
      clock: { now: () => NOW },
      ids: { next: this.nextId },
      places: {
        listCategories: async () => all(this.categories),
        getCategory: async (id) => get(this.categories, id),
        saveCategory: async (category, mode, changes) =>
          this.save(this.categories, category, mode, changes, (other) => other.code === category.code),
        listPlaceTypes: async () => all(this.placeTypes),
        getPlaceType: async (id) => get(this.placeTypes, id),
        savePlaceType: async (placeType, mode, changes) =>
          this.save(this.placeTypes, placeType, mode, changes, (other) => other.code === placeType.code),
      },
      parameters: {
        listParameters: async () => all(this.parameters),
        getParameter: async (id) => get(this.parameters, id),
        saveParameter: async (parameter, mode, changes) =>
          this.save(this.parameters, parameter, mode, changes, (other) => other.code === parameter.code),
        usageOf: async (parameterId) => this.usageOf(parameterId),
      },
      cleaningTypes: {
        listCleaningTypes: async () => all(this.cleaningTypes),
        getCleaningType: async (id) => get(this.cleaningTypes, id),
        saveCleaningType: async (type, mode, changes) =>
          this.save(this.cleaningTypes, type, mode, changes, (other) => other.code === type.code),
        listSkills: async () => all(this.skills),
        getSkill: async (id) => get(this.skills, id),
        saveSkill: async (skill, mode, _at, changes) =>
          this.save(this.skills, skill, mode, changes, (other) => other.code === skill.code),
      },
      offers: {
        listOffers: async (filter = {}) =>
          all(this.offers).filter(
            (offer) =>
              (!filter.placeTypeId || offer.placeTypeId === filter.placeTypeId) &&
              (!filter.cleaningTypeId || offer.cleaningTypeId === filter.cleaningTypeId),
          ),
        getOffer: async (id) => get(this.offers, id),
        saveOffer: async (offer, mode, changes) =>
          this.save(
            this.offers,
            offer,
            mode,
            changes,
            (other) =>
              other.placeTypeId === offer.placeTypeId && other.cleaningTypeId === offer.cleaningTypeId,
          ),
        listTariffs: async (offerIds) =>
          all(this.tariffs)
            .filter((tariff) => offerIds.includes(tariff.offerId))
            .sort((a, b) => b.version - a.version),
        getTariffsByIds: async (ids) => all(this.tariffs).filter((tariff) => ids.includes(tariff.id)),
        saveDraft: async (tariff, mode, changes) => {
          const taken = [...this.tariffs.values()].some(
            (other) => other.offerId === tariff.offerId && other.version === tariff.version,
          );
          if (mode === 'create' && taken) throw new DuplicateKeyError('concurrent');
          this.commit(changes, () => this.tariffs.set(tariff.id, clone(tariff)));
        },
        publish: async ({ tariffId, previousPublishedId, at, by, changes }) =>
          this.commit(changes, () => {
            const previous = previousPublishedId ? this.tariffs.get(previousPublishedId) : undefined;
            if (previous) previous.status = 'archived';
            const draft = this.tariffs.get(tariffId) as TariffVersion;
            Object.assign(draft, { status: 'published', publishedAt: at, publishedBy: by });
          }),
      },
      zones: {
        listZones: async () => all(this.zones),
        getZone: async (id) => get(this.zones, id),
        findByCommune: async (key) =>
          clone([...this.zones.values()].find((zone) => zone.communeKey === key) ?? null),
        saveZone: async (zone, mode, changes) =>
          this.save(this.zones, zone, mode, changes, (other) => other.communeKey === zone.communeKey),
        activityOf: async (keys) =>
          new Map(keys.map((key) => [key, this.activity.get(key) ?? { requests: [], activePrograms: 0 }])),
      },
      holidays: {
        listHolidays: async (year) =>
          [...this.holidays.values()]
            .filter((holiday) => holiday.active && (!year || holiday.date.startsWith(`${year}-`)))
            .sort((a, b) => a.date.localeCompare(b.date))
            .map(({ id, date, name }) => ({ id, date, name })),
        getHoliday: async (id) => {
          const holiday = this.holidays.get(id);
          return holiday?.active ? { id: holiday.id, date: holiday.date, name: holiday.name } : null;
        },
        addHoliday: async (holiday, _at, _by, changes) => {
          const sameDay = [...this.holidays.values()].find((other) => other.date === holiday.date);
          if (sameDay?.active) throw new DuplicateKeyError('code');
          const kept = { ...holiday, id: sameDay?.id ?? holiday.id };
          this.commit(changes, () => this.holidays.set(kept.id, { ...kept, active: true }));
          return kept;
        },
        removeHoliday: async (id, _at, _by, changes) =>
          this.commit(changes, () => {
            (this.holidays.get(id) as Holiday & { active: boolean }).active = false;
          }),
      },
      settings: { catalogSettings: async () => clone(this.settings) },
      communes: {
        listCommunes: async () => {
          if (this.communes === null) throw CleaningErrors.geoUnavailable();
          return clone(this.communes);
        },
      },
      idempotency: {
        find: async (ref) => this.records.get(`${ref.actorId}|${ref.operation}|${ref.key}`) ?? null,
      },
    };
  }

  private usageOf(parameterId: string): { offerIds: string[]; placeTypeIds: string[] } {
    const offerIds = [...this.tariffs.values()]
      .filter(
        (tariff) =>
          tariff.status === 'published' &&
          (tariff.baseParameterId === parameterId ||
            tariff.supplements.some((supplement) => supplement.parameterId === parameterId)),
      )
      .map((tariff) => tariff.offerId);
    const placeTypeIds = [...this.placeTypes.values()]
      .filter(
        (placeType) =>
          placeType.active &&
          (placeType.areaParameterId === parameterId ||
            placeType.parameters.some((link) => link.parameterId === parameterId)),
      )
      .map((placeType) => placeType.id);
    return { offerIds: [...new Set(offerIds)], placeTypeIds };
  }
}

/** Exécute dans le contexte d'un membre du personnel, double authentification récente. */
export function asStaff<T>(fn: () => T, userId = STAFF_ID): T {
  return runWithContext(
    {
      correlationId: '0192f1c4-0000-7000-8000-0000000000c1',
      user: {
        userId,
        sessionId: 's1',
        activeContext: 'personal',
        roles: [{ role: 'cleaning_admin', scopeType: 'global' }],
        mfa: true,
        authTime: Math.floor(Date.now() / 1000) - 60,
      },
    },
    fn,
  );
}
