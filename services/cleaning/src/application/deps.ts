import {
  type Clock,
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
}
