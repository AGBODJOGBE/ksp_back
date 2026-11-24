import { type AutoPlanningRepository } from './auto-planning/auto-planning.ports';
import { type SettingsRepository } from './settings/settings.use-cases';
import { type ClaimRepository } from './claims/claims.ports';
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
// Lot C
import { type DirectPayments, type PrepaidBalances } from './money/money.ports';
import {
  type CaseRepository,
  type CaseSettingsReader,
  type CommuneResolver,
  type PlaceRepository,
} from './requests/requests.ports';
// Lot E
import {
  type DirectPaymentGateway,
  type ExecutionRepository,
  type InvoiceIssuer,
  type WalletBalances,
} from './execution/execution.ports';
// Piste S
import { type PersonalDataRepository } from './privacy/privacy.ports';
// Piste A (agents)
import { type AgentAccounts, type AgentRoles } from './agents/agent.ports';

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
  // --- Lot C : lieux du client, demande, frais de visite, visite, constat, devis ---
  /** Dossiers : demande, frais, visites, version retenue, devis, programme créé à l'acceptation. */
  cases: CaseRepository;
  /** « Mes lieux » (partie 3). */
  clientPlaces: PlaceRepository;
  caseSettings: CaseSettingsReader;
  /** Commune par contour (geo.ResolveCommune, R-ZN-01). */
  communeResolver: CommuneResolver;
  /** Solde prépayé (wallet.GetPrepaidBalance). */
  balances: PrepaidBalances;
  /** Paiement direct par Mobile Money (payment.CreatePaymentRequest, R-WL-05). */
  directPayments: DirectPayments;
  // Lot E : programmes, séances, paiement par séance (facultatifs pour les lots qui ne s'en
  // servent pas ; les cas d'usage du lot E les exigent par ExecutionDeps).
  /** Programmes et séances, paiements et opérations de wallet. */
  execution?: ExecutionRepository;
  /** Solde prépayé lu par le lot E (wallet.GetPrepaidBalance). */
  walletBalances?: WalletBalances;
  /** Facture de séance (billing.IssueInvoice). */
  invoices?: InvoiceIssuer;
  /** Paiement direct Mobile Money d'une séance (payment.CreatePaymentRequest). */
  sessionPayments?: DirectPaymentGateway;
  /** Position des lieux (contrôle d'arrivée), déchiffrée à la demande. */
  placePoints?: { points(placeIds: readonly string[]): Promise<Map<string, GeoPoint>> };
  // --- Lot G : planification automatique, réglages, réclamations, renouvellement ---------------
  /** Planification automatique (UC-NT-38, UC-NT-45). */
  autoPlanning: AutoPlanningRepository;
  /** Réglages du module (UC-NT-43). */
  moduleSettings: SettingsRepository;
  /** Réclamations (UC-NT-17, UC-NT-40). */
  claims: ClaimRepository;
  // --- Piste S : suppression d'un compte et conservation des données (R-DP-01, R-DP-02) ---------
  /** Obligations avant la suppression d'un compte, effacement à la suppression, purge (UC-NT-48). */
  personalData?: PersonalDataRepository;
  // --- Piste A (agents) : rôle, compte et invitation d'un agent (facultatifs pour les lots qui ne
  // s'en servent pas ; les cas d'usage des agents les exigent par AgentDeps) ---------------------
  /** Rôle cleaning_agent chez identity (GrantRole, RevokeRole, R-AG-01). */
  roles?: AgentRoles;
  /** Compte KSP d'un agent créé par l'admin (identity.EnsureUserByPhone, R-AG-02). */
  accounts?: AgentAccounts;
}

/** Dépendances des cas d'usage du lot E. */
export type ExecutionDeps = CleaningDeps &
  Required<
    Pick<CleaningDeps, 'execution' | 'walletBalances' | 'invoices' | 'sessionPayments' | 'placePoints'>
  >;

/** Dépendances des cas d'usage de la piste S (données personnelles). */
export type PrivacyDeps = CleaningDeps & Required<Pick<CleaningDeps, 'personalData'>>;
/** Dépendances des cas d'usage des agents (piste A). */
export type AgentDeps = CleaningDeps & Required<Pick<CleaningDeps, 'roles' | 'accounts'>>;
