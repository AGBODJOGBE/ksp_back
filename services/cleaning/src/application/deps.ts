import { type PlanningRepository, type TravelTimes } from './planning/planning.ports';
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
  type FieldCipher,
  type GeoPoint,
  type IdempotencyStore,
  type IdGenerator,
  type PeopleDirectory,
  type PhotoStore,
  type ReverseGeocoder,
  type WalletLedger,
} from './ports';
// Lot E
import {
  type DirectPaymentGateway,
  type ExecutionRepository,
  type InvoiceIssuer,
  type WalletBalances,
} from './execution/execution.ports';

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
  /** Lot D : agents, disponibilités, équipes et affectations. */
  planning: PlanningRepository;
  /** Temps de trajet entre lieux (geo, R-ZN-02). */
  travel: TravelTimes;
  cipher: FieldCipher;
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
  // Lot E : programmes, séances, paiement par séance (facultatifs pour les lots qui ne s'en
  // servent pas ; les cas d'usage du lot E les exigent par ExecutionDeps).
  /** Programmes et séances, paiements et opérations de wallet. */
  execution?: ExecutionRepository;
  /** Solde prépayé (wallet.GetPrepaidBalance). */
  balances?: WalletBalances;
  /** Facture de séance (billing.IssueInvoice). */
  invoices?: InvoiceIssuer;
  /** Paiement direct Mobile Money (payment.CreatePaymentRequest). */
  directPayments?: DirectPaymentGateway;
  /** Position des lieux (contrôle d'arrivée), déchiffrée à la demande. */
  placePoints?: { points(placeIds: readonly string[]): Promise<Map<string, GeoPoint>> };
}

/** Dépendances des cas d'usage du lot E. */
export type ExecutionDeps = CleaningDeps &
  Required<Pick<CleaningDeps, 'execution' | 'balances' | 'invoices' | 'directPayments' | 'placePoints'>>;
