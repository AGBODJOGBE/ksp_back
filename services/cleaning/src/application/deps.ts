import {
  type CatalogSettingsReader,
  type CleaningTypeRepository,
  type CommuneDirectory,
  type HolidayRepository,
  type OfferRepository,
  type ParameterRepository,
  type PlaceCatalogRepository,
  type ZoneRepository,
} from './catalog/catalog.ports';
import {
  type Clock,
  type IdempotencyStore,
  type IdGenerator,
  type PeopleDirectory,
  type PhotoStore,
  type ReverseGeocoder,
  type WalletLedger,
} from './ports';

/** Jeton d'injection des dépendances des cas d'usage (racine de composition : app.module.ts). */
export const CLEANING_DEPS = Symbol('CLEANING_DEPS');

/**
 * Dépendances des cas d'usage : adaptateurs vers les autres services, horloge, identifiants. Les
 * dépôts Prisma v2 s'y ajoutent lot par lot, avec les cas d'usage qui les utilisent (ADR-054).
 */
export interface CleaningDeps {
  people: PeopleDirectory;
  wallet: WalletLedger;
  photos: PhotoStore;
  geocoder: ReverseGeocoder;
  clock: Clock;
  ids: IdGenerator;
  /** Lot A : catalogue, zones, jours fériés, réglages lus par le simulateur. */
  places: PlaceCatalogRepository;
  parameters: ParameterRepository;
  cleaningTypes: CleaningTypeRepository;
  offers: OfferRepository;
  zones: ZoneRepository;
  holidays: HolidayRepository;
  settings: CatalogSettingsReader;
  communes: CommuneDirectory;
  idempotency: IdempotencyStore;
}
